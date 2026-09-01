#!/usr/bin/env python3
"""Run a bounded real DSH TUI new/resume user loop under a pseudo-terminal.

The script intentionally treats the official DSH session directory as evidence
of identity only. It does not decode or copy session contents into CI artifacts.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import pty
import re
import secrets
import select
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

ANSI_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ANSI_OSC = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)")
SESSION_FILES = ("session.jsonl.zstd", "session.jsonl")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sanitize(text: str, secret_values: Iterable[str]) -> str:
    clean = ANSI_OSC.sub("", ANSI_CSI.sub("", text))
    for value in secret_values:
        if value:
            clean = clean.replace(value, "***REDACTED***")
    return clean


def discover_sessions(dsh_home: Path) -> dict[str, Path]:
    root = dsh_home / "sessions"
    found: dict[str, Path] = {}
    if not root.exists():
        return found
    for project in root.iterdir():
        if not project.is_dir():
            continue
        for session in project.iterdir():
            if not session.is_dir():
                continue
            for name in SESSION_FILES:
                transcript = session / name
                if transcript.exists():
                    found[session.name] = transcript
                    break
    return found


def wait_child(pid: int, timeout: float) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended == pid:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.1)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended == pid:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.1)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    ended, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status) if ended == pid else 124


def run_turn(
    *,
    node_bin: str,
    launcher: Path,
    args: list[str],
    prompt: str,
    expected: str,
    env: dict[str, str],
    timeout: float,
    secret_values: list[str],
) -> dict[str, object]:
    child_env = dict(env)
    child_env["DSH_TUI_FIRST_PROMPT"] = prompt
    child_env["TERM"] = child_env.get("TERM") or "xterm-256color"

    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(node_bin, [node_bin, str(launcher), *args], child_env)

    started = time.monotonic()
    raw = bytearray()
    matched = False
    exit_sent = False
    deadline = started + timeout
    exit_code: int | None = None

    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.5)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                raw.extend(chunk)
                decoded = sanitize(raw.decode("utf-8", errors="replace"), secret_values)
                if expected in decoded and not exit_sent:
                    matched = True
                    os.write(fd, b"/exit\r")
                    exit_sent = True
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended == pid:
                exit_code = os.waitstatus_to_exitcode(status)
                break

        if time.monotonic() >= deadline and exit_code is None:
            wait_child(pid, 0)
            transcript = sanitize(raw.decode("utf-8", errors="replace"), secret_values)
            raise RuntimeError(
                f"turn timed out after {timeout:.0f}s; expected marker was not observed. "
                f"Sanitized tail:\n{transcript[-2000:]}"
            )

        if exit_code is None:
            exit_code = wait_child(pid, 5)

        transcript = sanitize(raw.decode("utf-8", errors="replace"), secret_values)
        if not matched:
            raise RuntimeError(
                "TUI exited before the expected model marker was observed. "
                f"exit={exit_code}. Sanitized tail:\n{transcript[-2000:]}"
            )
        if exit_code != 0:
            raise RuntimeError(
                f"TUI returned non-zero after verified model output: {exit_code}. "
                f"Sanitized tail:\n{transcript[-2000:]}"
            )
        return {
            "matched": True,
            "exitCode": exit_code,
            "durationSeconds": round(time.monotonic() - started, 3),
        }
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def launcher_sessions(node_bin: str, launcher: Path, env: dict[str, str]) -> list[str]:
    result = subprocess.run(
        [node_bin, str(launcher), "sessions", "--porcelain"],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"sessions --porcelain failed with exit {result.returncode}")
    ids: list[str] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("no official sessions under "):
            continue
        ids.append(line.split("\t", 1)[0])
    return ids


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--launcher", default="apps/tui/dist/bin.js")
    parser.add_argument("--node", default="node")
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    parser.add_argument("--evidence-out", default="user-loop-evidence.json")
    parser.add_argument("--tag", default=os.environ.get("EVIDENCE_TAG", "unknown"))
    parser.add_argument("--commit", default=os.environ.get("EVIDENCE_COMMIT", ""))
    args = parser.parse_args()

    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        print("release commit must be a full lowercase 40-character Git SHA", file=sys.stderr)
        return 2

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        print("DEEPSEEK_API_KEY is required for a real user-loop run", file=sys.stderr)
        return 2

    dsh_home_raw = os.environ.get("DSH_HOME", "").strip()
    if not dsh_home_raw:
        print("DSH_HOME must be set to an isolated directory for evidence runs", file=sys.stderr)
        return 2

    dsh_home = Path(dsh_home_raw).resolve()
    launcher = Path(args.launcher).resolve()
    if not launcher.exists():
        print(f"launcher not found: {launcher}", file=sys.stderr)
        return 2

    dsh_home.mkdir(parents=True, exist_ok=True)
    if discover_sessions(dsh_home):
        print(f"refusing non-empty evidence DSH_HOME: {dsh_home}", file=sys.stderr)
        return 2

    env = dict(os.environ)
    env["DSH_HOME"] = str(dsh_home)
    secrets_to_redact = [api_key]

    version = subprocess.run(
        [args.node, str(launcher), "version"],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=True,
    ).stdout.strip()

    first_token = secrets.token_hex(8)
    first_expected = f"ACK-{first_token}"
    first_prompt = (
        "Reply with only ACK- immediately followed by this token, with no spaces, "
        f"punctuation, markdown, or explanation: {first_token}"
    )

    first = run_turn(
        node_bin=args.node,
        launcher=launcher,
        args=["new"],
        prompt=first_prompt,
        expected=first_expected,
        env=env,
        timeout=args.timeout_seconds,
        secret_values=secrets_to_redact,
    )

    sessions_after_new = discover_sessions(dsh_home)
    cli_ids_after_new = launcher_sessions(args.node, launcher, env)
    if len(sessions_after_new) != 1:
        raise RuntimeError(f"expected exactly one official session after new; found {len(sessions_after_new)}")
    session_id, transcript = next(iter(sessions_after_new.items()))
    if cli_ids_after_new != [session_id]:
        raise RuntimeError(
            f"launcher session view disagrees with official session root: {cli_ids_after_new!r} vs {session_id!r}"
        )
    first_mtime = transcript.stat().st_mtime_ns

    second_token = secrets.token_hex(8)
    second_expected = f"ACK-{second_token}"
    second_prompt = (
        "Reply with only ACK- immediately followed by this token, with no spaces, "
        f"punctuation, markdown, or explanation: {second_token}"
    )

    second = run_turn(
        node_bin=args.node,
        launcher=launcher,
        args=["resume", session_id],
        prompt=second_prompt,
        expected=second_expected,
        env=env,
        timeout=args.timeout_seconds,
        secret_values=secrets_to_redact,
    )

    sessions_after_resume = discover_sessions(dsh_home)
    cli_ids_after_resume = launcher_sessions(args.node, launcher, env)
    if set(sessions_after_resume) != {session_id}:
        raise RuntimeError(
            "resume created or switched to a different official session: "
            f"{sorted(sessions_after_resume)}"
        )
    if cli_ids_after_resume != [session_id]:
        raise RuntimeError(
            "launcher session view changed after resume: "
            f"{cli_ids_after_resume!r} vs {session_id!r}"
        )
    second_transcript = sessions_after_resume[session_id]
    if second_transcript.stat().st_mtime_ns <= first_mtime:
        raise RuntimeError("official session transcript mtime did not advance after resume turn")

    evidence = {
        "schemaVersion": 1,
        "status": "PASS",
        "generatedAt": now_iso(),
        "releaseTag": args.tag,
        "releaseCommit": args.commit,
        "endpoint": "linux-terminal",
        "runtimeIdentity": version,
        "githubRun": (
            f"{os.environ.get('GITHUB_SERVER_URL', '')}/"
            f"{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/"
            f"{os.environ.get('GITHUB_RUN_ID', '')}"
        ).strip("/"),
        "sessionEvidence": {
            "sessionCountAfterNew": len(sessions_after_new),
            "sessionCountAfterResume": len(sessions_after_resume),
            "sameSession": True,
            "sessionIdSha256": hashlib.sha256(session_id.encode("utf-8")).hexdigest(),
            "transcriptKind": second_transcript.name,
            "contentsExported": False,
        },
        "turns": {
            "new": first,
            "resume": second,
        },
        "privacy": {
            "isolatedDshHome": True,
            "apiKeyExported": False,
            "sessionContentsExported": False,
        },
    }

    Path(args.evidence_out).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

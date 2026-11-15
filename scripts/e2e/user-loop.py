#!/usr/bin/env python3
"""Run a bounded real DSH TUI new/resume user loop under a pseudo-terminal.

The script intentionally treats the official DSH session directory as evidence
of identity only. It does not decode or copy session contents into CI artifacts.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import pty
import re
import secrets
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

ANSI_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ANSI_OSC = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)")
SESSION_FILES = ("session.v4.jsonl.zstd", "session.jsonl.zstd", "session.jsonl")


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
    # The launcher deletes DSH_TUI_FIRST_PROMPT from its own environment and only
    # forwards a first turn that is passed as task text after `new` / `resume <id>`
    # (see apps/tui/src/launch.ts tuiLaunchEnv). Pass it as launcher args.
    child_env = dict(env)
    child_env.pop("DSH_TUI_FIRST_PROMPT", None)
    # Ink suppresses all live PTY frame rendering until unmount when `is-in-ci`
    # sees CI != 'false'/'0', which prevents interactive PTY drivers in GitHub
    # Actions from observing the assistant reply before sending `/exit`.
    child_env["CI"] = "false"
    args = [*args, prompt]
    child_env["TERM"] = child_env.get("TERM") or "xterm-256color"

    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(node_bin, [node_bin, str(launcher), *args], child_env)

    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
    except OSError:
        pass

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


def resolve_official_dsh_bin(node_bin: str, launcher: Path, env: dict[str, str]) -> Path:
    result = subprocess.run(
        [node_bin, str(launcher), "doctor"],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
    )
    match = re.search(r"官方 bin\s+(\S+)", result.stdout)
    if not match:
        raise RuntimeError(
            f"failed to resolve official dsh bin from doctor output:\n{result.stdout}\n{result.stderr}"
        )
    dsh_bin = Path(match.group(1)).resolve()
    if not dsh_bin.exists():
        raise RuntimeError(f"resolved official dsh bin does not exist: {dsh_bin}")
    return dsh_bin


def run_official_headless_turn(
    *,
    node_bin: str,
    dsh_bin: Path,
    session_cwd: Path,
    patch_file: Path | None,
    session_id: str,
    prompt: str,
    expected: str,
    env: dict[str, str],
    timeout: float,
    secret_values: list[str],
) -> dict[str, object]:
    cmd = [node_bin, str(dsh_bin), "--profile", "headless"]
    if patch_file is not None and patch_file.exists():
        cmd.extend(["--patch", str(patch_file)])
    cmd.extend(["--session-id", session_id, prompt])
    started = time.monotonic()
    result = subprocess.run(
        cmd,
        cwd=str(session_cwd),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    combined = sanitize(f"{result.stdout}\n{result.stderr}", secret_values)
    if result.returncode != 0:
        raise RuntimeError(
            f"official dsh --profile headless --session-id exited with {result.returncode}. "
            f"Sanitized tail:\n{combined[-2000:]}"
        )
    if expected not in sanitize(result.stdout, secret_values):
        raise RuntimeError(
            "official dsh --profile headless exited 0 without expected model marker. "
            f"Sanitized tail:\n{combined[-2000:]}"
        )
    return {
        "matched": True,
        "exitCode": result.returncode,
        "surface": "official-dsh-headless",
        "durationSeconds": round(time.monotonic() - started, 3),
    }


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

    if api_key.startswith("oc_sk_") or os.environ.get("DSH_USER_LOOP_PROVIDER") == "opencode-go":
        profile_dir = dsh_home / "profiles" / "dsh-community-tui"
        profile_dir.mkdir(parents=True, exist_ok=True)
        oc_model = os.environ.get("DSH_USER_LOOP_MODEL", "deepseek-v4.1-flash").strip() or "deepseek-v4.1-flash"
        oc_base_url = os.environ.get("DSH_USER_LOOP_BASE_URL", "https://opencode.ai/zen/go/v1").strip()
        oc_session = f"dsh-community-userloop-{secrets.token_hex(8)}"
        (profile_dir / "cordis.patch.yml").write_text(
            "# User layer for dsh-community-tui (OpenCode Go OpenAI-compatible route).\n"
            "- id: llm-pi-ai\n"
            "  config:\n"
            "    providers:\n"
            "      opencode-go:\n"
            "        apiKeyEnv: DEEPSEEK_API_KEY\n"
            "        api: openai-completions\n"
            f"        baseURL: {oc_base_url}\n"
            "        headers:\n"
            f"          x-opencode-session: {oc_session}\n"
            "        models:\n"
            f"          - id: {oc_model}\n"
            "- id: agent-default-model\n"
            "  config:\n"
            "    provider: opencode-go\n"
            f"    model: {oc_model}\n",
            encoding="utf-8",
        )

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
    second_mtime = second_transcript.stat().st_mtime_ns
    if second_mtime <= first_mtime:
        raise RuntimeError("official session transcript mtime did not advance after resume turn")

    official_dsh_bin = resolve_official_dsh_bin(args.node, launcher, env)
    session_cwd = dsh_home / "profiles" / "dsh-community-tui"
    provider_patch = session_cwd / "cordis.patch.yml"

    third_token = secrets.token_hex(8)
    third_expected = f"ACK-{third_token}"
    third_prompt = (
        "Reply with only ACK- immediately followed by this token, with no spaces, "
        f"punctuation, markdown, or explanation: {third_token}"
    )

    third = run_official_headless_turn(
        node_bin=args.node,
        dsh_bin=official_dsh_bin,
        session_cwd=session_cwd,
        patch_file=provider_patch if provider_patch.exists() else None,
        session_id=session_id,
        prompt=third_prompt,
        expected=third_expected,
        env=env,
        timeout=args.timeout_seconds,
        secret_values=secrets_to_redact,
    )

    sessions_after_official = discover_sessions(dsh_home)
    cli_ids_after_official = launcher_sessions(args.node, launcher, env)
    if set(sessions_after_official) != {session_id}:
        raise RuntimeError(
            "official headless handoff created or switched to a different session: "
            f"{sorted(sessions_after_official)}"
        )
    if cli_ids_after_official != [session_id]:
        raise RuntimeError(
            "launcher session view changed after official headless handoff: "
            f"{cli_ids_after_official!r} vs {session_id!r}"
        )
    third_transcript = sessions_after_official[session_id]
    third_mtime = third_transcript.stat().st_mtime_ns
    if third_mtime <= second_mtime:
        raise RuntimeError(
            "official session transcript mtime did not advance after official headless handoff turn"
        )

    fourth_token = secrets.token_hex(8)
    fourth_expected = f"ACK-{fourth_token}"
    fourth_prompt = (
        "Reply with only ACK- immediately followed by this token, with no spaces, "
        f"punctuation, markdown, or explanation: {fourth_token}"
    )

    fourth = run_turn(
        node_bin=args.node,
        launcher=launcher,
        args=["resume", session_id],
        prompt=fourth_prompt,
        expected=fourth_expected,
        env=env,
        timeout=args.timeout_seconds,
        secret_values=secrets_to_redact,
    )

    sessions_after_roundtrip = discover_sessions(dsh_home)
    cli_ids_after_roundtrip = launcher_sessions(args.node, launcher, env)
    if set(sessions_after_roundtrip) != {session_id}:
        raise RuntimeError(
            "community TUI resume after official handoff created or switched session: "
            f"{sorted(sessions_after_roundtrip)}"
        )
    if cli_ids_after_roundtrip != [session_id]:
        raise RuntimeError(
            "launcher session view changed after roundtrip resume: "
            f"{cli_ids_after_roundtrip!r} vs {session_id!r}"
        )
    fourth_transcript = sessions_after_roundtrip[session_id]
    if fourth_transcript.stat().st_mtime_ns <= third_mtime:
        raise RuntimeError(
            "official session transcript mtime did not advance after roundtrip TUI resume"
        )

    evidence = {
        "schemaVersion": 1,
        "status": "PASS",
        "generatedAt": now_iso(),
        "releaseTag": args.tag,
        "releaseCommit": args.commit,
        "endpoint": "linux-terminal+official-headless-cross-surface",
        "runtimeIdentity": version,
        "githubRun": (
            f"{os.environ.get('GITHUB_SERVER_URL', '')}/"
            f"{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/"
            f"{os.environ.get('GITHUB_RUN_ID', '')}"
        ).strip("/"),
        "sessionEvidence": {
            "sessionCountAfterNew": len(sessions_after_new),
            "sessionCountAfterResume": len(sessions_after_resume),
            "sessionCountAfterOfficialHandoff": len(sessions_after_official),
            "sessionCountAfterRoundtripResume": len(sessions_after_roundtrip),
            "sameSession": True,
            "crossSurfaceVerified": True,
            "surfaces": ["dsh-community-tui", "official-dsh-headless"],
            "sessionIdSha256": hashlib.sha256(session_id.encode("utf-8")).hexdigest(),
            "transcriptKind": fourth_transcript.name,
            "contentsExported": False,
        },
        "turns": {
            "new": first,
            "resume": second,
            "officialHeadlessHandoff": third,
            "resumeAfterOfficialHandoff": fourth,
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

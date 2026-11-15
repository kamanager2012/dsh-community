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
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
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


def _resolve_release_file(rel_path: str, release_root: Path | None) -> Path:
    repo_root = Path(__file__).resolve().parents[2]
    candidate_roots = [release_root, repo_root] if release_root is not None else [repo_root]
    for root in candidate_roots:
        if root is None:
            continue
        candidate = root / rel_path
        if candidate.exists():
            return candidate.resolve()
    raise RuntimeError(f"Could not locate {rel_path} in release checkout or repo")


def _resolve_marketplace_dist_dir(
    release_root: Path | None,
    work_dir: Path,
    node_bin: str,
) -> Path:
    repo_root = Path(__file__).resolve().parents[2]
    candidate_roots = [release_root, repo_root] if release_root is not None else [repo_root]
    for root in candidate_roots:
        if root is None:
            continue
        dist_dir = root / "packages" / "marketplace" / "dist"
        if (dist_dir / "client.js").exists() and (dist_dir / "cli.js").exists():
            return dist_dir.resolve()

    tsconfig = _resolve_release_file("packages/marketplace/tsconfig.json", release_root)
    tsc_bin: Path | None = None
    for root in candidate_roots:
        if root is None:
            continue
        candidate = root / "node_modules" / "typescript" / "bin" / "tsc"
        if candidate.exists():
            tsc_bin = candidate.resolve()
            break
    if tsc_bin is None:
        raise RuntimeError("Could not locate TypeScript compiler or prebuilt marketplace dist/")

    out_dir = work_dir / "marketplace-dist"
    out_dir.mkdir(parents=True, exist_ok=True)
    compile_res = subprocess.run(
        [node_bin, str(tsc_bin), "-p", str(tsconfig), "--outDir", str(out_dir)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=60,
        check=False,
    )
    if compile_res.returncode != 0 or not (out_dir / "client.js").exists():
        raise RuntimeError(
            f"Failed to compile marketplace package into temp dir ({compile_res.returncode}): "
            f"{compile_res.stdout}\n{compile_res.stderr}"
        )
    (out_dir / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
    return out_dir


def verify_version_upgrade_recovery(
    *,
    node_bin: str = "node",
    release_root: Path | None = None,
) -> dict[str, object]:
    runtime_catalog_ts = _resolve_release_file("packages/dsh-bridge/src/runtime-catalog.ts", release_root)
    runtime_view_ts = _resolve_release_file("apps/desktop/src/runtime-view.ts", release_root)
    tui_profile_ts = _resolve_release_file("apps/tui/src/profile.ts", release_root)
    latest_tested_json = _resolve_release_file("contracts/compatibility/latest-tested.json", release_root)
    target_version = json.loads(latest_tested_json.read_text(encoding="utf-8")).get("version", "0.2.2-rc.3")
    prior_version = "0.1.1-rc.2" if target_version == "0.2.2-rc.2" else "0.2.2-rc.2"

    with tempfile.TemporaryDirectory(prefix="dsh-upgrade-recovery-") as tmp_raw:
        tmp = Path(tmp_raw)
        catalog_path = tmp / "runtime-versions.json"
        catalog_path.write_text(
            json.dumps(
                {
                    "latestTested": prior_version,
                    "defaultPin": prior_version,
                    "projects": {"/work": prior_version},
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        dsh_home_upgrade = tmp / "dsh-home"
        session_file = dsh_home_upgrade / "sessions" / "--work--" / "sess-upgrade-1" / "session.v4.jsonl.zstd"
        session_file.parent.mkdir(parents=True, exist_ok=True)
        session_payload = b"prior-session-frame\n"
        session_file.write_bytes(session_payload)

        profile_dir = dsh_home_upgrade / "profiles" / "dsh-community-tui"
        profile_dir.mkdir(parents=True, exist_ok=True)
        (profile_dir / "package.json").write_text(
            json.dumps(
                {
                    "name": "dsh-profile-dsh-community-tui",
                    "private": True,
                    "dependencies": {
                        "@dsh-community/tui-surface": f"file:/old/v{prior_version}/packages/tui",
                        "user-custom-plugin": "1.2.3",
                    },
                    "dsh": {
                        "profile": {
                            "bundles": ["@deepseek-ai/dsh-base", "@deepseek-harness-tui/dsh-tui"]
                        }
                    },
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        custom_patch = f"# Custom user patch from {prior_version}\n- id: custom\n  config: {{}}\n"
        (profile_dir / "cordis.patch.yml").write_text(custom_patch, encoding="utf-8")

        js_runner = (
            'import { readFileSync, writeFileSync } from "node:fs";\n'
            'import { pathToFileURL } from "node:url";\n'
            'const [catalogTs, viewTs, profileTs, latestTestedPath, catalogPath, dshHome, priorVersion] = process.argv.slice(1);\n'
            'const rc = await import(pathToFileURL(catalogTs).href);\n'
            'const rv = await import(pathToFileURL(viewTs).href);\n'
            'const prof = await import(pathToFileURL(profileTs).href);\n'
            'const latestTested = rv.readLatestTested(JSON.parse(readFileSync(latestTestedPath, "utf8")), "fallback");\n'
            'if (!latestTested || latestTested === "fallback") throw new Error("failed to read latest-tested.json");\n'
            'const seeded = rc.parseRuntimeCatalog(JSON.parse(readFileSync(catalogPath, "utf8")));\n'
            'if (!seeded) throw new Error("seeded runtime-versions.json failed parseRuntimeCatalog");\n'
            'const hydratedPrior = rc.hydrateCatalog(seeded, latestTested, priorVersion);\n'
            'const priorRec = rc.recommendUpdate(hydratedPrior, priorVersion);\n'
            'if (hydratedPrior.latestTested !== latestTested || priorRec !== "offer-tested" || hydratedPrior.defaultPin !== priorVersion || hydratedPrior.projects["/work"] !== priorVersion) {\n'
            '  throw new Error(`unexpected prior upgrade hydration state: ${JSON.stringify({ hydratedPrior, priorRec, priorVersion })}`);\n'
            '}\n'
            'const hydratedCurrent = rc.hydrateCatalog(hydratedPrior, latestTested, latestTested);\n'
            'const view = rv.buildRuntimeView({\n'
            '  installed: latestTested,\n'
            '  catalog: hydratedCurrent,\n'
            '  officialHome: dshHome,\n'
            '  desktopRoot: dshHome,\n'
            '  catalogPath,\n'
            '  isolated: false,\n'
            '});\n'
            'if (view.recommendation !== "stay" || !view.canSwitchToTested) {\n'
            '  throw new Error(`unexpected post-upgrade RuntimeView: ${JSON.stringify(view)}`);\n'
            '}\n'
            'const pinned = rc.pinDefault(hydratedCurrent, latestTested);\n'
            'writeFileSync(catalogPath, JSON.stringify(pinned, null, 2) + "\\n");\n'
            'const profileRes = prof.ensureCommunityTuiProfile({ dshHome, communityPatch: `# v${latestTested}\\n[]\\n` });\n'
            'if (profileRes.created !== false) throw new Error("expected existing TUI profile to upgrade in place");\n'
            'const updatedManifest = JSON.parse(readFileSync(`${profileRes.dir}/package.json`, "utf8"));\n'
            'if (updatedManifest.dependencies?.["user-custom-plugin"] !== "1.2.3") throw new Error("lost user custom plugin dependency on upgrade");\n'
            'if (updatedManifest.dependencies?.["@dsh-community/tui-surface"] !== prof.communityTuiPackageSpec()) throw new Error("failed to upgrade tui-surface spec");\n'
            'if (JSON.stringify(updatedManifest.dsh?.profile?.bundles) !== JSON.stringify([...prof.COMMUNITY_TUI_BUNDLES])) throw new Error("failed to upgrade profile bundles");\n'
            'const userPatchAfter = readFileSync(`${profileRes.dir}/cordis.patch.yml`, "utf8");\n'
            'if (!userPatchAfter.includes(`Custom user patch from ${priorVersion}`)) throw new Error("clobbered user cordis.patch.yml on upgrade");\n'
            'console.log(JSON.stringify({\n'
            '  targetVersion: latestTested,\n'
            '  priorRec,\n'
            '  postRec: view.recommendation,\n'
            '  pinnedDefault: pinned.defaultPin,\n'
            '  tuiProfileUpgradedInPlace: true,\n'
            '}));\n'
        )
        res = subprocess.run(
            [
                node_bin,
                "--input-type=module",
                "-e",
                js_runner,
                str(runtime_catalog_ts),
                str(runtime_view_ts),
                str(tui_profile_ts),
                str(latest_tested_json),
                str(catalog_path),
                str(dsh_home_upgrade),
                prior_version,
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
        if res.returncode != 0:
            raise RuntimeError(
                f"verify_version_upgrade_recovery failed ({res.returncode}):\n{res.stdout}\n{res.stderr}"
            )
        if not session_file.exists() or session_file.read_bytes() != session_payload:
            raise RuntimeError("version upgrade recovery altered or removed existing official session file")
        parsed = json.loads(res.stdout.strip().splitlines()[-1])
        return {
            "modules": [
                "packages/dsh-bridge/src/runtime-catalog.ts",
                "apps/desktop/src/runtime-view.ts",
                "apps/tui/src/profile.ts",
            ],
            "fromVersion": prior_version,
            "toVersion": parsed["targetVersion"],
            "priorInstallRecommendation": parsed["priorRec"],
            "postUpgradeRecommendation": parsed["postRec"],
            "tuiProfileUpgradedInPlace": parsed["tuiProfileUpgradedInPlace"],
            "existingSessionsPreserved": True,
        }


def verify_offline_handling(
    *,
    node_bin: str = "node",
    release_root: Path | None = None,
) -> dict[str, object]:
    plugin_catalog_ts = _resolve_release_file("packages/dsh-bridge/src/plugin-catalog.ts", release_root)
    desktop_mkt_ts = _resolve_release_file("apps/desktop/src/marketplace.ts", release_root)
    desktop_pages_ts = _resolve_release_file("apps/desktop/src/pages.ts", release_root)
    catalog_json = _resolve_release_file("packages/marketplace/catalog.json", release_root)

    with tempfile.TemporaryDirectory(prefix="dsh-offline-handling-") as tmp_raw:
        tmp = Path(tmp_raw)
        mkt_dist_dir = _resolve_marketplace_dist_dir(release_root, tmp, node_bin)
        client_js = mkt_dist_dir / "client.js"
        cli_js = mkt_dist_dir / "cli.js"

        offline_home = tmp / "home"
        cache_file = offline_home / ".cache" / "dsh-community" / "marketplace-catalog.json"
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        raw_catalog_text = catalog_json.read_text(encoding="utf-8")
        cache_file.write_text(raw_catalog_text, encoding="utf-8")

        js_runner = (
            'import { readFileSync } from "node:fs";\n'
            'import { pathToFileURL } from "node:url";\n'
            'const [pluginCatalogTs, clientJs, cliJs, desktopMktTs, desktopPagesTs, cacheFile, offlineHome, catalogJson] = process.argv.slice(1);\n'
            'const pc = await import(pathToFileURL(pluginCatalogTs).href);\n'
            'const client = await import(pathToFileURL(clientJs).href);\n'
            'const cli = await import(pathToFileURL(cliJs).href);\n'
            'const mkt = await import(pathToFileURL(desktopMktTs).href);\n'
            'const pages = await import(pathToFileURL(desktopPagesTs).href);\n'
            'let tuiOfflineRejected = false;\n'
            'try {\n'
            '  await pc.fetchPluginCatalog("http://127.0.0.1:1/offline-catalog.json", 1500);\n'
            '} catch (err) {\n'
            '  tuiOfflineRejected = err instanceof Error && err.message.length > 0;\n'
            '}\n'
            'if (!tuiOfflineRejected) throw new Error("expected fetchPluginCatalog to fail closed when offline");\n'
            'const cachedFetch = await client.fetchCatalog({ url: "http://127.0.0.1:1/offline-catalog.json", cachePath: cacheFile });\n'
            'if (cachedFetch.source !== "cache" || cachedFetch.catalog.plugins.length < 1) {\n'
            '  throw new Error(`expected marketplace fetchCatalog cache fallback, got ${JSON.stringify(cachedFetch)}`);\n'
            '}\n'
            'const origLog = console.log;\n'
            'const origWarn = console.warn;\n'
            'const captured = [];\n'
            'console.log = (...args) => captured.push(args.join(" "));\n'
            'console.warn = (...args) => captured.push(args.join(" "));\n'
            'let cliCode = -1;\n'
            'try {\n'
            '  cliCode = await cli.runMarketplaceCli({\n'
            '    args: ["list"],\n'
            '    homeDir: offlineHome,\n'
            '    fetchImpl: async () => { throw new Error("offline ECONNREFUSED"); },\n'
            '  });\n'
            '} finally {\n'
            '  console.log = origLog;\n'
            '  console.warn = origWarn;\n'
            '}\n'
            'if (cliCode !== 0 || !captured.some((line) => line.includes("使用本地缓存"))) {\n'
            '  throw new Error(`expected marketplace CLI cache fallback exit 0, got ${cliCode}: ${captured.join(" | ")}`);\n'
            '}\n'
            'const rawCatalog = JSON.parse(readFileSync(catalogJson, "utf8"));\n'
            'const parsedDesktopCatalog = mkt.parseMarketplaceCatalog(rawCatalog);\n'
            'if (!parsedDesktopCatalog) throw new Error("desktop parseMarketplaceCatalog rejected catalog.json");\n'
            'const fallbackSnap = mkt.parseMarketplaceSnapshot(mkt.marketplaceSnapshot({\n'
            '  catalog: parsedDesktopCatalog,\n'
            '  source: "cache",\n'
            '  fetchedAt: "2026-11-15T00:00:00.000Z",\n'
            '  error: "在线抓取失败，展示最近一次缓存。",\n'
            '}));\n'
            'if (!fallbackSnap || fallbackSnap.catalog?.plugins.length !== parsedDesktopCatalog.plugins.length) {\n'
            '  throw new Error("failed to roundtrip desktop cached marketplace snapshot");\n'
            '}\n'
            'const cachedHtml = pages.renderMarketplacePage({\n'
            '  product: "DSH Community",\n'
            '  catalog: fallbackSnap.catalog,\n'
            '  source: "cache",\n'
            '  fetchedAt: fallbackSnap.fetchedAt,\n'
            '  error: fallbackSnap.error,\n'
            '  registryUrl: mkt.MARKETPLACE_REGISTRY_URL,\n'
            '  installed: [],\n'
            '  profile: "web",\n'
            '});\n'
            'if (!cachedHtml.includes("缓存目录（网络不可用，展示最近一次抓取）") || !cachedHtml.includes("在线抓取失败，展示最近一次缓存。")) {\n'
            '  throw new Error("desktop cached marketplace page missing offline fallback banner");\n'
            '}\n'
            'const uncachedHtml = pages.renderMarketplacePage({\n'
            '  product: "DSH Community",\n'
            '  source: "none",\n'
            '  fetchedAt: "2026-11-15T00:00:00.000Z",\n'
            '  error: "无法抓取目录:http://127.0.0.1:1/offline-catalog.json",\n'
            '  registryUrl: mkt.MARKETPLACE_REGISTRY_URL,\n'
            '  installed: [],\n'
            '  profile: "web",\n'
            '});\n'
            'if (!uncachedHtml.includes("目录不可用") || !uncachedHtml.includes("无法抓取目录")) {\n'
            '  throw new Error("desktop uncached offline marketplace page missing unavailable banner");\n'
            '}\n'
            'console.log(JSON.stringify({\n'
            '  tuiOfflineFailClosed: tuiOfflineRejected,\n'
            '  marketplaceClientCacheFallback: cachedFetch.source === "cache",\n'
            '  marketplaceCliCacheFallback: cliCode === 0,\n'
            '  desktopSnapshotAndRenderVerified: true,\n'
            '  cachedPluginCount: parsedDesktopCatalog.plugins.length,\n'
            '}));\n'
        )
        res = subprocess.run(
            [
                node_bin,
                "--input-type=module",
                "-e",
                js_runner,
                str(plugin_catalog_ts),
                str(client_js),
                str(cli_js),
                str(desktop_mkt_ts),
                str(desktop_pages_ts),
                str(cache_file),
                str(offline_home),
                str(catalog_json),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
        if res.returncode != 0:
            raise RuntimeError(
                f"verify_offline_handling failed ({res.returncode}):\n{res.stdout}\n{res.stderr}"
            )
        parsed = json.loads(res.stdout.strip().splitlines()[-1])
        return {
            "modules": [
                "packages/dsh-bridge/src/plugin-catalog.ts",
                "packages/marketplace/src/client.ts",
                "packages/marketplace/src/cli.ts",
                "apps/desktop/src/marketplace.ts",
                "apps/desktop/src/pages.ts",
            ],
            **parsed,
        }


def verify_appimage_gui_session_and_lifecycle(
    *,
    apprun_path: Path,
    dsh_home: Path,
    session_id: str,
    env: dict[str, str],
    expected_version: str = "0.2.2-rc.3",
    prior_version: str = "0.2.2-rc.2",
    release_root: Path | None = None,
    node_bin: str = "node",
    timeout: float = 90.0,
) -> dict[str, object]:
    if not apprun_path.exists():
        raise RuntimeError(f"--appimage-apprun does not exist: {apprun_path}")

    catalog_json = _resolve_release_file("packages/marketplace/catalog.json", release_root)
    parsed_catalog_payload = json.loads(catalog_json.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory(prefix="dsh-appimage-gui-") as sandbox_raw:
        sandbox = Path(sandbox_raw)
        home_dir = sandbox / "home"
        config_dir = sandbox / "xdg-config"
        data_dir = sandbox / "xdg-data"
        user_data_dir = sandbox / "electron-userdata"
        workspace_dir = sandbox / "workspace"
        pid_file = sandbox / "electron.pid"
        for d in (home_dir, config_dir, data_dir, user_data_dir, workspace_dir):
            d.mkdir(parents=True, exist_ok=True)

        (user_data_dir / "desktop-settings.json").write_text(
            json.dumps({"hideToTray": False, "isolated": False}, indent=2) + "\n",
            encoding="utf-8",
        )
        (user_data_dir / "runtime-versions.json").write_text(
            json.dumps(
                {
                    "latestTested": prior_version,
                    "defaultPin": prior_version,
                    "projects": {"/work": prior_version},
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        # Seed an expired persisted snapshot (>10m TTL) so showMarketplace()
        # exercises the production refreshMarketplaceCatalog() offline fallback.
        (user_data_dir / "marketplace-catalog.json").write_text(
            json.dumps(
                {
                    "source": "live",
                    "fetchedAt": "2026-01-01T00:00:00.000Z",
                    "catalog": parsed_catalog_payload,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        prior_stamp = user_data_dir / "official-dsh" / prior_version / ".dsh-host-ready"
        prior_stamp.parent.mkdir(parents=True, exist_ok=True)
        prior_stamp.write_text(f"{prior_version}\n", encoding="utf-8")

        child_env = dict(env)
        for key in (
            "DSH_COMMUNITY_ISOLATED",
            "DSH_COMMUNITY_BIN",
            "DSH_DESKTOP_NODE_EXECUTABLE",
            "DSH_REMOTE_CONFIG_DIR",
        ):
            child_env.pop(key, None)
        child_env["HOME"] = str(home_dir)
        child_env["XDG_CONFIG_HOME"] = str(config_dir)
        child_env["XDG_DATA_HOME"] = str(data_dir)
        child_env["TMPDIR"] = str(sandbox)
        child_env["DSH_HOME"] = str(dsh_home)
        child_env["DSH_DESKTOP_CWD"] = str(workspace_dir)
        child_env["NODE_USE_ENV_PROXY"] = "1"
        child_env["HTTPS_PROXY"] = "http://127.0.0.1:1"
        child_env["https_proxy"] = "http://127.0.0.1:1"
        child_env["HTTP_PROXY"] = "http://127.0.0.1:1"
        child_env["http_proxy"] = "http://127.0.0.1:1"
        child_env["NO_PROXY"] = "127.0.0.1,localhost"
        child_env["no_proxy"] = "127.0.0.1,localhost"

        use_xvfb = not child_env.get("DISPLAY") and shutil.which("xvfb-run") is not None
        launch_timeout_ms = max(90_000, int(timeout * 1000))

        driver_js = r'''
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [
  apprunPath,
  userDataDir,
  workspaceDir,
  dshHome,
  sessionId,
  expectedVersion,
  priorVersion,
  timeoutMsRaw,
  useXvfbRaw,
  pidFile,
] = process.argv.slice(1);

const timeoutMs = Number(timeoutMsRaw) || 90000;
const useXvfb = useXvfbRaw === "1";
const DEVTOOLS_RE = /DevTools listening on (ws:\/\/[^\s]+)/u;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function selectMainShellTarget(targets) {
  if (!Array.isArray(targets)) return undefined;
  return targets.find((target) => {
    if (!target || typeof target !== "object") return false;
    if (target.type !== "page" || typeof target.url !== "string") return false;
    if (!target.url.startsWith("data:text/html;charset=utf-8,")) return false;
    try {
      const html = decodeURIComponent(target.url.slice("data:text/html;charset=utf-8,".length));
      return html.includes("window.dshCommunity");
    } catch {
      return false;
    }
  });
}

function findOfficialWebOrigin(targets) {
  if (!Array.isArray(targets)) return undefined;
  for (const target of targets) {
    if (!target || typeof target !== "object" || typeof target.url !== "string") continue;
    try {
      const url = new URL(target.url);
      if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "") {
        return url.origin;
      }
    } catch {}
  }
  return undefined;
}

function killProcessTree(child, signal = "SIGKILL", forceGroup = false) {
  if (!child || typeof child.pid !== "number") return;
  const stillRunning = child.exitCode === null && child.signalCode === null;
  if (!stillRunning && !forceGroup) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  if (stillRunning) {
    try { child.kill(signal); } catch {}
  }
}

async function connectCdp(wsUrl, onRuntimeError) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error(`CDP open timeout: ${wsUrl}`)), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    ws.addEventListener("error", (ev) => { clearTimeout(timer); rejectOpen(new Error(`CDP error: ${String(ev)}`)); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (typeof msg.id === "number") {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown" && onRuntimeError) {
      const details = msg.params?.exceptionDetails;
      onRuntimeError(`Renderer exceptionThrown: ${details?.exception?.description ?? details?.text ?? "unknown"}`);
    } else if (msg.method === "Log.entryAdded" && onRuntimeError) {
      const entry = msg.params?.entry;
      if (entry && (entry.source === "security" || entry.level === "error")) {
        onRuntimeError(`Renderer Log [${entry.source}/${entry.level}]: ${entry.text ?? ""}`);
      }
    } else if (msg.method === "Runtime.consoleAPICalled" && onRuntimeError && msg.params?.type === "error") {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      onRuntimeError(`Renderer console.error: ${text}`);
    }
  });
  const clearPending = (reason) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason(entry.method)));
      pending.delete(id);
    }
  };
  ws.addEventListener("close", () => clearPending((m) => `CDP closed before ${m}`));
  function call(method, params = {}, callTimeout = 15000) {
    return new Promise((resolveCall, rejectCall) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`CDP timeout (${method})`));
      }, callTimeout);
      pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const res = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res?.exceptionDetails) {
      throw new Error(`Runtime.evaluate exception: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "unknown"}`);
    }
    return res?.result?.value;
  }
  return {
    call,
    evaluate,
    close: () => {
      clearPending((m) => `CDP client closed before ${m}`);
      try { ws.close(); } catch {}
    },
  };
}

async function waitForCondition(label, waitMs, errors, probeFn) {
  const deadline = Date.now() + waitMs;
  let lastError;
  while (Date.now() < deadline) {
    if (errors.length > 0) throw new Error(`Renderer errors while waiting for [${label}]: ${errors.join(" | ")}`);
    try {
      const v = await probeFn();
      if (v) return v;
      lastError = undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Execution context was destroyed") || msg.includes("Cannot find context with specified id")) {
        lastError = msg;
      } else {
        throw err;
      }
    }
    await sleep(200);
  }
  throw new Error(`Timed out after ${waitMs}ms waiting for [${label}]${lastError ? ` (last: ${lastError})` : ""}`);
}

const electronArgs = [
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataDir}`,
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
];
const cmd = useXvfb ? "xvfb-run" : apprunPath;
const args = useXvfb ? ["-a", "-s", "-screen 0 1280x800x24", apprunPath, ...electronArgs] : electronArgs;

const child = spawn(cmd, args, {
  cwd: workspaceDir,
  env: process.env,
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
if (typeof child.pid === "number") {
  writeFileSync(pidFile, String(child.pid), "utf8");
}

const stderrLines = [];
const stdoutLines = [];
const rendererErrors = [];
let browserWsUrl;

child.stdout?.on("data", (chunk) => {
  stdoutLines.push(String(chunk));
  if (stdoutLines.length > 100) stdoutLines.shift();
});
child.stderr?.on("data", (chunk) => {
  const text = String(chunk);
  stderrLines.push(text);
  if (stderrLines.length > 100) stderrLines.shift();
  if (!browserWsUrl) {
    const m = text.match(DEVTOOLS_RE);
    if (m?.[1]) browserWsUrl = m[1];
  }
});

const exitPromise = new Promise((resolveExit) => {
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});

let browserCdp;
let pageCdp;
let cleanExit = false;

try {
  await waitForCondition("DevTools WebSocket URL", 30000, rendererErrors, async () => {
    if (child.exitCode !== null) throw new Error(`AppImage exited early (${String(child.exitCode)})`);
    return browserWsUrl;
  });

  const debugOrigin = new URL(browserWsUrl).origin.replace(/^ws:/u, "http:");
  browserCdp = await connectCdp(browserWsUrl);

  const shellTarget = await waitForCondition("Main Electron shell target", 30000, rendererErrors, async () => {
    const res = await fetch(`${debugOrigin}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    return selectMainShellTarget(await res.json());
  });

  pageCdp = await connectCdp(shellTarget.webSocketDebuggerUrl, (msg) => rendererErrors.push(msg));
  await pageCdp.call("Runtime.enable");
  await pageCdp.call("Log.enable");

  let officialOrigin = "";
  await waitForCondition("Host ready and official dsh web view", timeoutMs, rendererErrors, async () => {
    const snap = await pageCdp.evaluate(`(async () => {
      if (!window.dshCommunity || typeof window.dshCommunity.hostSnapshot !== "function") return null;
      const snapshot = await window.dshCommunity.hostSnapshot();
      const sessionsBtn = document.querySelector('button[data-go="sessions"]');
      const runtimeBtn = document.querySelector('button[data-go="runtime"]');
      const marketplaceBtn = document.querySelector('button[data-go="marketplace"]');
      return { phase: snapshot?.phase ?? null, hasNav: Boolean(sessionsBtn && runtimeBtn && marketplaceBtn) };
    })()`);
    if (!snap || snap.phase !== "ready" || !snap.hasNav) return undefined;
    const res = await fetch(`${debugOrigin}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const origin = findOfficialWebOrigin(await res.json());
    if (!origin) return undefined;
    officialOrigin = origin;
    return snap;
  });

  await pageCdp.evaluate(`(() => {
    const btn = document.querySelector('button[data-go="sessions"]');
    if (!btn) throw new Error("Missing sessions nav button");
    btn.click();
    return true;
  })()`);

  const escapedSessionIdLiteral = JSON.stringify(sessionId);
  const sessionsCheck = await waitForCondition("Sessions page shows shared loop session", 20000, rendererErrors, async () => {
    return pageCdp.evaluate(`(() => {
      const sid = ${escapedSessionIdLiteral};
      const table = document.getElementById("sessions-table");
      if (!table) return null;
      const copyBtn = Array.from(document.querySelectorAll("button[data-copy-id]")).find((b) => b.getAttribute("data-copy-id") === sid);
      const resumeBtn = Array.from(document.querySelectorAll("button[data-resume]")).find((b) => b.getAttribute("data-resume") === sid);
      if (!copyBtn || !resumeBtn) return null;
      return {
        title: document.title,
        text: document.body?.innerText ?? "",
        rowCount: document.querySelectorAll("tr[data-session-row]").length,
      };
    })()`);
  });

  if (!sessionsCheck.text.includes(dshHome) || sessionsCheck.text.includes("（隔离）")) {
    throw new Error(`Sessions page did not show shared DSH_HOME (${dshHome}): ${sessionsCheck.text.slice(0, 500)}`);
  }

  await pageCdp.evaluate(`(() => {
    const btn = document.querySelector('button[data-go="runtime"]');
    if (!btn) throw new Error("Missing runtime nav button");
    btn.click();
    return true;
  })()`);

  const runtimeCheck = await waitForCondition("Runtime page reflects upgraded runtime", 20000, rendererErrors, async () => {
    return pageCdp.evaluate(`(() => {
      const text = document.body?.innerText ?? "";
      if (!document.title.includes("运行时") || !text.includes("Version Manager")) return null;
      if (!text.includes("@deepseek-ai/dsh@")) return null;
      return { title: document.title, text };
    })()`);
  });

  if (!runtimeCheck.text.includes(`@deepseek-ai/dsh@${expectedVersion}`) || !runtimeCheck.text.includes(priorVersion)) {
    throw new Error(`Runtime page mismatch: expected @deepseek-ai/dsh@${expectedVersion} and preserved defaultPin ${priorVersion}, got:\n${runtimeCheck.text}`);
  }

  await pageCdp.evaluate(`(() => {
    const btn = document.querySelector('button[data-go="marketplace"]');
    if (!btn) throw new Error("Missing marketplace nav button");
    btn.click();
    return true;
  })()`);

  const marketplaceCheck = await waitForCondition("Marketplace offline fallback rendered via refreshMarketplaceCatalog", 25000, rendererErrors, async () => {
    return pageCdp.evaluate(`(() => {
      const text = document.body?.innerText ?? "";
      if (!document.title.includes("社区市场")) return null;
      if (!text.includes("在线抓取失败，展示最近一次缓存。")) return null;
      if (!text.includes("缓存目录（网络不可用，展示最近一次抓取）")) return null;
      const pluginButtons = document.querySelectorAll("[data-plugin-action]").length;
      if (pluginButtons < 1) return null;
      return { title: document.title, pluginButtons };
    })()`);
  });

  if (rendererErrors.length > 0) {
    throw new Error(`Renderer errors observed: ${rendererErrors.join(" | ")}`);
  }

  await browserCdp.call("Browser.close").catch(() => {});
  pageCdp.close();
  pageCdp = undefined;
  browserCdp.close();
  browserCdp = undefined;

  let exitResult = await Promise.race([exitPromise, sleep(10000).then(() => ({ timedOut: true }))]);
  if (exitResult.timedOut) {
    killProcessTree(child, "SIGTERM");
    exitResult = await Promise.race([exitPromise, sleep(10000).then(() => ({ timedOut: true }))]);
  }
  if (exitResult.timedOut || exitResult.code !== 0) {
    throw new Error(`AppImage GUI did not exit 0 cleanly: ${JSON.stringify(exitResult)}`);
  }
  cleanExit = true;

  console.log(JSON.stringify({
    launched: true,
    officialWebReady: Boolean(officialOrigin),
    sessionRowCount: sessionsCheck.rowCount,
    sharedHomeRendered: true,
    sessionVisibleInGui: true,
    runtimeUpgradeRenderedInGui: true,
    marketplaceOfflineCacheFallbackInGui: true,
    marketplacePluginCountInGui: marketplaceCheck.pluginButtons,
    rendererErrorsCount: rendererErrors.length,
    exitCode: exitResult.code,
  }));
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  if (stderrLines.length > 0) console.error("--- Electron stderr tail ---\n" + stderrLines.join(""));
  if (stdoutLines.length > 0) console.error("--- Electron stdout tail ---\n" + stdoutLines.join(""));
  process.exitCode = 1;
} finally {
  pageCdp?.close();
  browserCdp?.close();
  killProcessTree(child, "SIGKILL", !cleanExit);
}
'''

        proc = subprocess.Popen(
            [
                node_bin,
                "--input-type=module",
                "-e",
                driver_js,
                str(apprun_path),
                str(user_data_dir),
                str(workspace_dir),
                str(dsh_home),
                session_id,
                expected_version,
                prior_version,
                str(launch_timeout_ms),
                "1" if use_xvfb else "0",
                str(pid_file),
            ],
            env=child_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        outer_timeout = (launch_timeout_ms / 1000.0) + 180.0
        stdout_text = ""
        stderr_text = ""
        try:
            stdout_text, stderr_text = proc.communicate(timeout=outer_timeout)
        except subprocess.TimeoutExpired as exc:
            stdout_text = exc.stdout or ""
            stderr_text = exc.stderr or ""
            raise RuntimeError(
                f"verify_appimage_gui_session_and_lifecycle timed out after {outer_timeout:.0f}s:\n"
                f"{stdout_text[-2000:]}\n{stderr_text[-2000:]}"
            ) from exc
        finally:
            pids_to_kill: list[int] = []
            if pid_file.exists():
                try:
                    raw_pid = pid_file.read_text(encoding="utf-8").strip()
                    if raw_pid:
                        pids_to_kill.append(int(raw_pid))
                except (OSError, ValueError):
                    pass
            if proc.poll() is None:
                pids_to_kill.append(proc.pid)
            for pgid in dict.fromkeys(pids_to_kill):
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    try:
                        os.killpg(pgid, sig)
                    except (ProcessLookupError, PermissionError):
                        pass
                    if sig == signal.SIGTERM:
                        time.sleep(0.2)
            if proc.poll() is None:
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        proc.kill()
                        proc.wait(timeout=5)
                    except OSError:
                        pass

        if proc.returncode != 0:
            raise RuntimeError(
                f"verify_appimage_gui_session_and_lifecycle failed ({proc.returncode}):\n"
                f"{stdout_text[-2000:]}\n{stderr_text[-2000:]}"
            )

        upgraded_catalog = json.loads((user_data_dir / "runtime-versions.json").read_text(encoding="utf-8"))
        if upgraded_catalog.get("latestTested") != expected_version:
            raise RuntimeError(
                f"Expected AppImage GUI to hydrate latestTested={expected_version}, got {upgraded_catalog!r}"
            )
        if upgraded_catalog.get("defaultPin") != prior_version or upgraded_catalog.get("projects") != {"/work": prior_version}:
            raise RuntimeError(
                f"AppImage GUI unexpectedly lost prior pin metadata during upgrade: {upgraded_catalog!r}"
            )

        ready_stamp = user_data_dir / "official-dsh" / expected_version / ".dsh-host-ready"
        if not ready_stamp.exists() or not prior_stamp.exists():
            raise RuntimeError(
                f"Missing runtime stamps after AppImage upgrade boot: current={ready_stamp.exists()}, prior={prior_stamp.exists()}"
            )

        gui_metrics = json.loads(stdout_text.strip().splitlines()[-1])
        return {
            **gui_metrics,
            "runtimeCatalogHydratedOnDisk": True,
            "priorRuntimePreserved": True,
            "currentRuntimeExtractedReady": True,
        }


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


def verify_missing_key_refusal_and_recovery(
    node_bin: str,
    launcher: Path,
    dsh_home: Path,
    env: dict[str, str],
) -> dict[str, object]:
    child_env = dict(env)
    child_env.pop("DEEPSEEK_API_KEY", None)
    child_env["DSH_HOME"] = str(dsh_home)
    child_env["CI"] = "false"
    child_env["TERM"] = child_env.get("TERM") or "xterm-256color"

    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(node_bin, [node_bin, str(launcher), "new", "ping"], child_env)

    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
    except OSError:
        pass

    raw = bytearray()
    exit_code: int | None = None
    deadline = time.monotonic() + 30.0
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.25)
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
            if exit_code is None:
                ended, status = os.waitpid(pid, os.WNOHANG)
                if ended == pid:
                    exit_code = os.waitstatus_to_exitcode(status)
        if exit_code is None:
            exit_code = wait_child(pid, 5)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass

    output = sanitize(raw.decode("utf-8", errors="replace"), [])
    if exit_code == 0:
        raise RuntimeError(
            f"missing-key invocation unexpectedly exited 0. Sanitized tail:\n{output[-2000:]}"
        )
    if "DEEPSEEK_API_KEY" not in output:
        raise RuntimeError(
            f"missing-key refusal did not mention DEEPSEEK_API_KEY. Sanitized tail:\n{output[-2000:]}"
        )
    remaining = discover_sessions(dsh_home)
    if remaining:
        raise RuntimeError(f"missing-key refusal left orphan sessions: {sorted(remaining)}")
    return {
        "refusedCleanly": True,
        "exitCode": exit_code,
        "orphanSessions": len(remaining),
    }


def verify_interrupted_extract_recovery(
    archive_path: Path,
    work_dir: Path,
    *,
    node_bin: str = "node",
    release_root: Path | None = None,
) -> tuple[Path, dict[str, object]]:
    repo_root = Path(__file__).resolve().parents[2]
    candidate_roots = [release_root, repo_root] if release_root is not None else [repo_root]
    host_extract_ts: Path | None = None
    for root in candidate_roots:
        if root is None:
            continue
        candidate = root / "apps" / "desktop" / "src" / "host-extract.ts"
        if candidate.exists():
            host_extract_ts = candidate.resolve()
            break
    if host_extract_ts is None:
        raise RuntimeError(
            "Could not locate apps/desktop/src/host-extract.ts in release checkout or repo"
        )

    dest_root = work_dir / "official-dsh"
    partial_dir = dest_root / "node_modules" / "@deepseek-ai" / "dsh" / "lib"
    partial_dir.mkdir(parents=True, exist_ok=True)
    partial_marker = dest_root / "node_modules" / "@deepseek-ai" / "dsh" / "partial.tmp"
    partial_marker.write_text("interrupted\n", encoding="utf-8")
    partial_bin = partial_dir / "bin.js"
    partial_bin.write_text("// truncated interrupted extract\n", encoding="utf-8")

    ready_stamp = dest_root / ".dsh-host-ready"
    if ready_stamp.exists():
        raise RuntimeError("simulated interrupted extract unexpectedly has .dsh-host-ready stamp")

    js_runner = (
        'import("node:url").then(async ({ pathToFileURL }) => {'
        '  const mod = await import(pathToFileURL(process.argv[1]).href);'
        '  const archivePath = process.argv[2];'
        '  const destRoot = process.argv[3];'
        '  const readyBefore = mod.isOfficialHostReady(destRoot);'
        '  if (readyBefore) {'
        '    throw new Error("expected isOfficialHostReady(destRoot) to be false before recovery");'
        '  }'
        '  const bin = mod.ensureOfficialHostExtracted({ archivePath, destRoot });'
        '  const readyAfter = mod.isOfficialHostReady(destRoot);'
        '  if (!readyAfter) {'
        '    throw new Error("expected isOfficialHostReady(destRoot) to be true after recovery");'
        '  }'
        '  console.log(JSON.stringify({ bin, readyBefore, readyAfter }));'
        '}).catch((err) => {'
        '  console.error(err);'
        '  process.exit(1);'
        '});'
    )
    extract = subprocess.run(
        [node_bin, "-e", js_runner, str(host_extract_ts), str(archive_path), str(dest_root)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
        check=False,
    )
    if extract.returncode != 0:
        raise RuntimeError(
            f"ensureOfficialHostExtracted recovery failed ({extract.returncode}): {extract.stderr[-1000:]}"
        )
    if partial_marker.exists():
        raise RuntimeError("stale partial.tmp survived ensureOfficialHostExtracted recovery")

    dsh_bin = dest_root / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
    app_boot = dest_root / "node_modules" / "@deepseek-ai" / "dsh-app-boot" / "package.json"
    if not dsh_bin.exists() or not app_boot.exists() or not ready_stamp.exists():
        raise RuntimeError(
            "recovered AppImage runtime extract is incomplete: "
            f"bin={dsh_bin.exists()}, app_boot={app_boot.exists()}, ready={ready_stamp.exists()}"
        )
    if partial_bin.read_text(encoding="utf-8", errors="replace").startswith("// truncated interrupted extract"):
        raise RuntimeError("stale truncated bin.js survived ensureOfficialHostExtracted recovery")
    return dsh_bin, {
        "extractor": "apps/desktop/src/host-extract.ts#ensureOfficialHostExtracted",
        "interruptedStateDetected": True,
        "recoveredCleanly": True,
        "readyStampWritten": ready_stamp.exists(),
    }


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
    surface: str = "official-dsh-headless",
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
            f"{surface} --profile headless --session-id exited with {result.returncode}. "
            f"Sanitized tail:\n{combined[-2000:]}"
        )
    if expected not in sanitize(result.stdout, secret_values):
        raise RuntimeError(
            f"{surface} --profile headless exited 0 without expected model marker. "
            f"Sanitized tail:\n{combined[-2000:]}"
        )
    return {
        "matched": True,
        "exitCode": result.returncode,
        "surface": surface,
        "durationSeconds": round(time.monotonic() - started, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--launcher", default="apps/tui/dist/bin.js")
    parser.add_argument("--appimage-archive", default="")
    parser.add_argument("--appimage-apprun", default="")
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

    missing_key_recovery = verify_missing_key_refusal_and_recovery(
        args.node, launcher, dsh_home, env
    )

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

    launcher_resolved = launcher.resolve()
    release_root = launcher_resolved.parents[3] if len(launcher_resolved.parents) > 3 else None

    surfaces = ["dsh-community-tui", "official-dsh-headless"]
    turns: dict[str, object] = {
        "new": first,
        "resume": second,
        "officialHeadlessHandoff": third,
    }
    lifecycle_recovery: dict[str, object] = {
        "missingKeyRefusal": missing_key_recovery,
        "versionUpgrade": verify_version_upgrade_recovery(
            node_bin=args.node,
            release_root=release_root,
        ),
        "offlineHandling": verify_offline_handling(
            node_bin=args.node,
            release_root=release_root,
        ),
    }
    latest_mtime = third_mtime
    session_count_after_appimage: int | None = None
    appimage_gui_verification: dict[str, object] | None = None

    appimage_archive_raw = args.appimage_archive.strip()
    if appimage_archive_raw:
        appimage_archive = Path(appimage_archive_raw).resolve()
        if not appimage_archive.exists():
            raise RuntimeError(f"--appimage-archive does not exist: {appimage_archive}")
        with tempfile.TemporaryDirectory(prefix="dsh-appimage-recovery-") as recovery_tmp:
            appimage_dsh_bin, extract_recovery = verify_interrupted_extract_recovery(
                appimage_archive,
                Path(recovery_tmp),
                node_bin=args.node,
                release_root=release_root,
            )
            lifecycle_recovery["interruptedRuntimeExtract"] = extract_recovery

            appimage_token = secrets.token_hex(8)
            appimage_expected = f"ACK-{appimage_token}"
            appimage_prompt = (
                "Reply with only ACK- immediately followed by this token, with no spaces, "
                f"punctuation, markdown, or explanation: {appimage_token}"
            )
            appimage_turn = run_official_headless_turn(
                node_bin=args.node,
                dsh_bin=appimage_dsh_bin,
                session_cwd=session_cwd,
                patch_file=provider_patch if provider_patch.exists() else None,
                session_id=session_id,
                prompt=appimage_prompt,
                expected=appimage_expected,
                env=env,
                timeout=args.timeout_seconds,
                secret_values=secrets_to_redact,
                surface="linux-appimage-bundled-runtime",
            )
            sessions_after_appimage = discover_sessions(dsh_home)
            cli_ids_after_appimage = launcher_sessions(args.node, launcher, env)
            if set(sessions_after_appimage) != {session_id}:
                raise RuntimeError(
                    "AppImage bundled runtime handoff created or switched session: "
                    f"{sorted(sessions_after_appimage)}"
                )
            if cli_ids_after_appimage != [session_id]:
                raise RuntimeError(
                    "launcher session view changed after AppImage runtime handoff: "
                    f"{cli_ids_after_appimage!r} vs {session_id!r}"
                )
            appimage_transcript = sessions_after_appimage[session_id]
            appimage_mtime = appimage_transcript.stat().st_mtime_ns
            if appimage_mtime <= latest_mtime:
                raise RuntimeError(
                    "official session transcript mtime did not advance after AppImage runtime handoff"
                )
            latest_mtime = appimage_mtime
            session_count_after_appimage = len(sessions_after_appimage)
            surfaces.append("linux-appimage-bundled-runtime")
            turns["appimageBundledRuntimeHandoff"] = appimage_turn

    appimage_apprun_raw = args.appimage_apprun.strip()
    if appimage_apprun_raw:
        latest_tested_path = _resolve_release_file(
            "contracts/compatibility/latest-tested.json", release_root
        )
        expected_version = json.loads(latest_tested_path.read_text(encoding="utf-8"))["version"]
        prior_version = "0.1.1-rc.2" if expected_version == "0.2.2-rc.2" else "0.2.2-rc.2"
        appimage_gui_verification = verify_appimage_gui_session_and_lifecycle(
            apprun_path=Path(appimage_apprun_raw).resolve(),
            dsh_home=dsh_home,
            session_id=session_id,
            env=env,
            expected_version=expected_version,
            prior_version=prior_version,
            release_root=release_root,
            node_bin=args.node,
            timeout=args.timeout_seconds,
        )
        sessions_after_gui = discover_sessions(dsh_home)
        if set(sessions_after_gui) != {session_id}:
            raise RuntimeError(
                "AppImage GUI session visibility check altered sessions: "
                f"{sorted(sessions_after_gui)}"
            )
        surfaces.append("linux-appimage-electron-gui")
        upgrade_info = lifecycle_recovery.get("versionUpgrade")
        if isinstance(upgrade_info, dict):
            upgrade_info["appimageGuiUpgradeVerified"] = True
        offline_info = lifecycle_recovery.get("offlineHandling")
        if isinstance(offline_info, dict):
            offline_info["desktopMarketplaceCacheFallback"] = bool(
                appimage_gui_verification.get("marketplaceOfflineCacheFallbackInGui")
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
    if fourth_transcript.stat().st_mtime_ns <= latest_mtime:
        raise RuntimeError(
            "official session transcript mtime did not advance after roundtrip TUI resume"
        )
    turns["resumeAfterOfficialHandoff"] = fourth

    session_evidence: dict[str, object] = {
        "sessionCountAfterNew": len(sessions_after_new),
        "sessionCountAfterResume": len(sessions_after_resume),
        "sessionCountAfterOfficialHandoff": len(sessions_after_official),
        "sessionCountAfterRoundtripResume": len(sessions_after_roundtrip),
        "sameSession": True,
        "crossSurfaceVerified": True,
        "surfaces": surfaces,
        "sessionIdSha256": hashlib.sha256(session_id.encode("utf-8")).hexdigest(),
        "transcriptKind": fourth_transcript.name,
        "contentsExported": False,
    }
    if session_count_after_appimage is not None:
        session_evidence["sessionCountAfterAppimageHandoff"] = session_count_after_appimage
    if appimage_gui_verification is not None:
        session_evidence["appimageGuiSessionVerified"] = True
        session_evidence["appimageGuiVerification"] = appimage_gui_verification

    endpoint_label = "linux-terminal+official-headless-cross-surface"
    if appimage_gui_verification is not None and session_count_after_appimage is not None:
        endpoint_label = "linux-terminal+official-headless+appimage-bundled-runtime+appimage-electron-gui"
    elif appimage_gui_verification is not None:
        endpoint_label = "linux-terminal+official-headless+appimage-electron-gui"
    elif session_count_after_appimage is not None:
        endpoint_label = "linux-terminal+official-headless+appimage-bundled-runtime"

    evidence = {
        "schemaVersion": 1,
        "status": "PASS",
        "generatedAt": now_iso(),
        "releaseTag": args.tag,
        "releaseCommit": args.commit,
        "endpoint": endpoint_label,
        "runtimeIdentity": version,
        "githubRun": (
            f"{os.environ.get('GITHUB_SERVER_URL', '')}/"
            f"{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/"
            f"{os.environ.get('GITHUB_RUN_ID', '')}"
        ).strip("/"),
        "sessionEvidence": session_evidence,
        "lifecycleRecovery": lifecycle_recovery,
        "turns": turns,
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

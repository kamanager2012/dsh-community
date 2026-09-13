# acs_core/paths.py — Agent-agnostic path protection
# Used by all ACS adapter variants.

import os
from pathlib import Path
from typing import Set

# ── Forbidden system roots ──────────────────────────────────────────────────

FORBIDDEN_ROOTS: Set[str] = {
    "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64",
    "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var",
}


def is_forbidden_path(fp: str) -> str | None:
    """Check if a file path is under a forbidden system root.
    Returns the matching root if forbidden, None if allowed.
    """
    resolved = str(Path(fp).resolve())
    for root in FORBIDDEN_ROOTS:
        if resolved == root or resolved.startswith(root + os.sep):
            return root
    return None


def is_self_protect(fp: str, protected_dirs: list[str]) -> bool:
    """Check if a file path is within protected directories (self-protection)."""
    resolved = str(Path(fp).resolve())
    return any(d in resolved for d in protected_dirs)


# ── ACS self-protection: all 9 supported agent runtime/hooks roots ──────────
#
# Writing to an agent's hooks/runtime directory from the agent's own Write/Edit
# tool is always self-tamper (overwriting the engine, clearing the score file,
# moving hook scripts aside, etc.). ACS manages those paths internally and must
# never let the guarded agent write to them directly.
#
# Used by every adapter's handle_write AND by the benchmark self_protect
# category, so the harness exercises the exact guard the runtime uses.

# Base directory names for each supported agent (under $HOME)
AGENT_BASE_DIRS: frozenset[str] = frozenset({
    ".claude", ".codebuddy", ".codex", ".cursor", ".gemini",
    ".grok", ".hermes", ".opencode", ".qoder-cn",
})

# Subdirectories inside an agent base dir that hold ACS engine/runtime state.
AGENT_PROTECTED_SUBDIRS: tuple[str, ...] = (
    "hooks", "runtime", "governance", "agent-hooks",
    "cacs_runtime", "gacs_runtime", "grok_acs_runtime",
    "hacs_runtime", "qacs_runtime",
)

# Path fragments that identify a protected ACS location, e.g.
#   "/.claude/hooks", "/.codex/cacs_runtime", "/.hermes/agent-hooks"
# plus the shared core package directory.
SELF_PROTECT_FRAGMENTS: frozenset[str] = frozenset(
    f"/{base}/{sub}"
    for base in AGENT_BASE_DIRS
    for sub in AGENT_PROTECTED_SUBDIRS
) | {".acs_core", "/.acs_core"}


def is_self_protect_path(fp: str) -> str | None:
    """Return the matched protected fragment if `fp` lies inside any ACS
    protected agent runtime/hooks directory (or the shared .acs_core core),
    else None.

    Substring matching means it catches both absolute paths
    (/home/user/.claude/hooks/acs_lite.py) and relative ones (.codex/cacs_runtime/...).
    """
    try:
        resolved = str(Path(fp).resolve())
    except (OSError, RuntimeError):
        resolved = str(fp)
    for frag in SELF_PROTECT_FRAGMENTS:
        if frag in resolved:
            return frag
    return None

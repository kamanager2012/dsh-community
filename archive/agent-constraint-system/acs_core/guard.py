# acs_core/guard.py -- Agent-agnostic Bash and Git guard patterns
# Used by all ACS adapter variants.

import re
from typing import List, Optional, Tuple

# -- Dangerous Bash patterns --

# ACS self-protect: one source of truth for agent dirs + protected subdirs.
# Mirrors paths.AGENT_BASE_DIRS / paths.AGENT_PROTECTED_SUBDIRS so the Bash
# guard and the Write guard block exactly the same locations.
_AGENT = r"(?:claude|codebuddy|codex|cursor|gemini|grok|hermes|opencode|qoder-cn|acs_core)"
_AGENT_SUB = r"(?:hooks|runtime|governance|agent-hooks|cacs_runtime|gacs_runtime|grok_acs_runtime|hacs_runtime|qacs_runtime)"

DANGEROUS_BASH: List[Tuple[str, str]] = [
    # DELETE — catastrophic recursive-rm targets (always BLOCK, including in
    # context-aware mode). The BLANKET recursive-rm block (any target) is kept
    # separately as _BLANKET_RECURSIVE_RM: check_bash (Level 1, pattern-only)
    # applies it unconditionally, but check_bash_with_context skips it so
    # non-catastrophic recursive rm routes to the Asset Ledger instead of being
    # short-circuited by the regex layer. See check_bash_with_context.
    (r"\b(?:^|[|;&]|\s*&&\s*|\s*\|\|\s*)\s*rm\s+-[a-zA-Z]*[rf]\s+/(?:\s|$)",       "rm -rf /"),
    (r"\b(?:^|[|;&]|\s*&&\s*|\s*\|\|\s*)\s*rm\s+-[a-zA-Z]*[rf]\s+/\*",             "rm -rf /*"),
    (r"\b(?:^|[|;&]|\s*&&\s*|\s*\|\|\s*)\s*rm\s+-[a-zA-Z]*[rf]\s+\*",              "rm -rf *"),
    (r"\b(?:^|[|;&]|\s*&&\s*|\s*\|\|\s*)\s*rm\s+-[a-zA-Z]*[rf]\s+~",                "rm -rf ~"),
    (r"\b(?:^|[|;&]|\s*&&\s*|\s*\|\|\s*)\s*rm\s+-[a-zA-Z]*[rf]\s+\S*(?:PROJ|REPO|project|repo)\b", "rm -rf project/repo"),
    (r"\btruncate\s+-s\s+0",                                   "truncate to zero"),
    # FIND with delete/exec (bypasses rm -rf pattern checks)
    (r"\bfind\b.{0,2048}\s+-exec\s+(?:rm|sh|bash|python)\b",     "find -exec (dangerous)"),
    (r"\bfind\b.{0,2048}\s+-delete\b",                            "find -delete (destroys files)"),
    # xargs with dangerous commands
    (r"\bxargs\b.*\brm\s+-[rf]",                                "xargs rm (via pipeline)"),

    # SYSTEM
    (r"\b(?:^|[|;&]|\s*&&\s*|\s*\|\|\s*|sudo\s+|exec\s+|env\s+|nice\s+|command\s+)*\s*kill\s+-9\b",  "kill -9 (force kill)"),
    (r"\bmkfs(?:\.\w+|\s+-t\s+\w+)",                            "mkfs (disk format)"),
    (r"\b(?:^|[|;&]|\s*&&\s*|\s*\|\|\s*|sudo\s+|exec\s+|env\s+|nice\s+|command\s+)*\s*dd\s+if=/dev/","dd writing to block device"),
    (r"\breboot\b",                                             "reboot"),
    (r"\bshutdown\b",                                           "shutdown"),
    (r":\(\s*\)\s*\{",                                         "fork bomb (colon style)"),
    # \w{1,64}: the greedy \w+ + backtracking-at-every-start-position scan is
    # O(n²) on long word-run input with no '(' (measured 1.4s on 40KB).
    # {0,256} on adjacent [^}]* keeps the separator ambiguity bounded —
    # realistic fork bombs (name + payload) are all < 60 chars.
    # ^\s* anchors at line start but allows leading whitespace — a bare
    # `bomb() {...}` with a leading space is valid bash and must not bypass.
    (r"(?:^\s*|[\n;&|]\s*)\w{1,64}\(\s*\)\s*\{[^}]{0,256}\|[^}]{0,256}&\s*[^}]{0,256}\}", "fork bomb (named func style)"),

    # EXEC -- inline interpreter
    (r"\b(?:node|python3?|perl|ruby|php|lua)\s+-[ce]\b",      "inline interpreter execution"),
    (r"\b(?:python3?|node|perl|ruby|bash)\s+<<",               "heredoc interpreter"),
    (r"\beval\s+\$",                                            "eval with variable/substitution"),

    # BYPASS -- encoding/decoding pipe chains. Adjacent bounded stars would
    # multiply worst-case work (bound1×bound2): the FIRST star keeps {0,2048}
    # (long URLs/paths before the pipe are legit) while the LAST star drops to
    # {0,256} (the "| sh" tail is always short), capping the product ~500K.
    (r"\bbase64\s+(?:-d|--decode)(?:(?!\|).){0,2048}\|(?:(?!\b(?:ba)?sh\b).){0,256}(?:ba)?sh\b", "base64 decode pipe to shell"),
    (r"\bxxd\s+-r\s+-p(?:(?!\|).){0,2048}\|(?:(?!\b(?:ba)?sh\b).){0,256}(?:ba)?sh\b",        "xxd decode pipe to shell"),
    (r"\bopenssl\s+(?:base64|enc)\s+-d(?:(?!\|).){0,2048}\|(?:(?!\b(?:ba)?sh\b).){0,256}(?:ba)?sh\b", "openssl decode pipe to shell"),
    (r"\b(?:nc|ncat)\s+.{0,2048}\|\s*(?:ba)?sh\b",            "netcat pipe to shell"),
    # Alternative decoders (Python, Perl, Ruby)
    (r"\b(?:python3?|perl|ruby)\s+-[ce]\s+(?:import\s+base64|MIME::Base64|Base64)", "scripted base64 decode"),
    (r"\bpython3?\s+-c\s+(?:(?!base64).){0,2048}base64(?:(?!\.decode\().){0,256}\.decode\(",  "python base64 decode"),
    # Nested decode inside command substitution (4 bounded stars: 256³ caps
    # the product ~16M worst; realistic gaps between tokens are < 30 chars)
    (r"sh\s+-c\s+(?:(?!\$\().){0,256}\$\((?:(?!\b(?:base64|xxd|openssl)\b).){0,256}\b(?:base64|xxd|openssl)\b(?:(?!\|\s*(?:ba)?sh\b).){0,256}\|\s*(?:ba)?sh", "nested decode in subshell"),
    (r"\bsh\s+-c\s+(?:(?!\$\().){0,256}\$\((?:(?!base64).){0,256}base64(?:(?!-d\b).){0,256}-d(?:(?!\)).){0,256}\)", "sh -c with base64 decode subshell"),
    # Git with variable args (potential indirection)
    (r"\bgit\s+\$\w+\s+\$\w+",                                "git with variable arguments"),
    # Alias definition + execution in same command
    (r"\balias\s+(\w+)=.*;\s*\1\b",                           "alias definition then execution"),
    # EVAL bypass: eval with any substitution mechanism
    (r"\beval\s+(?:\$\(|`|\"|\$)\S*",                         "eval with substitution (potential bypass)"),

    # WRITE
    (r"\bchmod\s+777\b",                                       "chmod 777"),
    (r"\bchmod\s+(?:-R\s+)?777\s+/(?:etc|usr|bin|sbin|var|tmp|home|root|opt)/",
     "chmod 777 on system path"),
    (r"\bchown\s+root\b",                                      "chown root"),
    (r">\s*/etc/",                                              "overwrite /etc file"),
    (r">\s*/(?:etc|boot)/",                                     "redirect overwrite to system path"),
    (r"\bsed\b\s+-i\b",                                       "sed -i (WSL in-place edit, rename race risk)"),
    (r"\bsed\b\s+--in-place\b",                               "sed --in-place (WSL truncation risk)"),
    # File injection into system directories
    (r"\b(?:mv|cp|install)\s+.*\s+/(?:etc|usr/bin|usr/sbin|bin|sbin|boot)/",
     "file injection into system directory"),
    (r"\bln\s+-s[f]?\s+.*\s+/(?:etc|usr|bin|sbin|boot)/",
     "symlink injection into system directory"),

    # ANTI-FORENSIC
    (r"\bhistory\s+-[cw]\b",                                   "clear shell history"),
    (r"\bunset\s+HISTFILE\b",                                  "disable shell history"),
    (r"\bcat\s+/etc/(?:shadow|passwd)\b",                      "read /etc sensitive"),

    # NETWORK
    (r"\b(?:wget|curl)\b.{0,2048}\|\s*(?:sh|bash)\b",         "download pipe shell"),
    (r"\bcurl(?:(?!\|).){0,2048}\|(?:(?!\b(?:ba)?sh\b).){0,256}(?:ba)?sh",                      "curl-pipe-shell"),

    # ── ACS SELF-PROTECT ── covers ALL 9 supported agent runtime/hooks dirs ──
    # Agent base dirs + protected subdirs (kept here so every pattern below
    # shares one source of truth; see also paths.AGENT_BASE_DIRS).
    (r"\bchmod\s+.*-[a-z]*x[a-z]*.*(?:acs_|" + _AGENT + r")", "chmod on ACS engine"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*(?:acs_|" + _AGENT + r"/)", "ACS tamper: engine"),
    # Redirect (echo/cat/tee/dd >, including >>) into any agent runtime/hooks dir
    (r">>?\s*\S*?\." + _AGENT + r"/" + _AGENT_SUB, "ACS tamper: redirect into runtime/hooks"),
    # Destructive file ops (rm/mv/cp/truncate/shred) on agent runtime/hooks dirs.
    # NOTE: .*? (not \S*) so it survives the space inside "rm -rf /path".
    (r"\b(?:rm|mv|cp|truncate|shred)\b(?:\s+-[a-zA-Z]+)*\s+.*?\.?" + _AGENT + r"/" + _AGENT_SUB,
     "ACS tamper: agent runtime/hooks"),
    # in-place edit of agent runtime/hooks files
    (r"\bsed\b\s+-i\b.*?\.?" + _AGENT + r"/" + _AGENT_SUB, "ACS tamper: sed -i agent dir"),
    # symlink injection into agent runtime/hooks
    (r"\bln\s+-s[f]?\s+.*?\.?" + _AGENT + r"/" + _AGENT_SUB, "ACS tamper: symlink into agent dir"),
    # Absolute-path rm bypass for destructive commands
    (r"\b(?:^|[|;&]|\s*&&\s*|\s*\|\|\s*|sudo\s+|exec\s+|env\s+|nice\s+)\s*(?:/usr)?/bin/rm\s+-[a-zA-Z]*[rf]\s+/",
     "rm via absolute path"),
]

COMPILED_DANGEROUS = [(re.compile(p, re.IGNORECASE), desc) for p, desc in DANGEROUS_BASH]

# Blanket recursive-rm block (any target). Applied by check_bash (Level 1,
# pattern-only) so the pattern layer fail-closes on all `rm -r*`. SKIPPED by
# check_bash_with_context (which passes _skip_blanket_rm=True for recursive rm)
# so non-catastrophic recursive rm reaches the Asset Ledger. Catastrophic
# targets above (/ , ~, system, repo root, self-protect) still BLOCK first via
# the dedicated patterns + the paths-based check in check_bash_with_context.
_BLANKET_RECURSIVE_RM = re.compile(r"\brm\b\s+-[a-zA-Z]*[rR][a-zA-Z]*\b", re.IGNORECASE)
_BLANKET_RECURSIVE_RM_DESC = "rm recursive (rm -rf) — always blocked"

# Recursive-rm detector + first-target extractor for the asset-aware path.
_RECURSIVE_RM_RE = re.compile(r"\brm\b\s+-[a-zA-Z]*[rR][a-zA-Z]*\b", re.IGNORECASE)
_RM_TARGET_RE = re.compile(r"\brm\b\s+-[a-zA-Z]*[rR][a-zA-Z]*\b\s+(\S+)", re.IGNORECASE)

# Recognized rebuildable / temporary assets: recursive rm on these is ALLOWed
# (asset-aware path). Mirrors the project's asset-state decision table.
_REBUILDABLE_RE = re.compile(
    r"(^|/)(node_modules|dist|build|target|out|\.cache|__pycache__|\.next|\.turbo|coverage)(/|$)"
    r"|^/tmp/|^/var/tmp/|/cache/|/temp/|/tmp$",
    re.IGNORECASE,
)

# -- Git destructive patterns --

GIT_DESTRUCTIVE: List[Tuple[str, str]] = [
    (r"git\s+restore\s+--\s+\.$",               "git restore -- . (uncontrolled overwrite)"),
    (r"git\s+reset\s+--hard",                   "git reset --hard (destroys uncommitted work)"),
    (r"git\s+clean\s+-[fdx]+",                  "git clean (deletes untracked files)"),
    (r"git\s+push\s+--force(?!-)",               "git push --force (overwrites remote history)"),
    (r"git\s+push\s+-f\b",                     "git push -f (overwrites remote history)"),
    (r"git\s+checkout\s+--\s+\.",              "git checkout -- . (discards all changes)"),
    (r"git\s+branch\s+-[dD]\s+(?:main|master)\b", "git branch -d/D main/master (protected)"),
    (r"git\s+branch\s+-[mM]\s+(?:main|master)\b", "git branch -m/M main/master (protected)"),
]

COMPILED_GIT = [(re.compile(p, re.IGNORECASE), desc) for p, desc in GIT_DESTRUCTIVE]


# -- Command cleaning --

def clean_command(cmd: str) -> str:
    """Remove content inside quotes, heredocs, and decode content."""
    result = cmd
    result = re.sub(r"'[^']*'", "''", result)
    result = re.sub(r'"[^"\\]*(?:\\.[^"\\]*)*"', '""', result)
    result = re.sub(
        r'<<\s*["\']?(\w+)["\']?\s*\n.*?\n\s*\1',
        '<<HEREDOC>>', result, flags=re.DOTALL
    )
    return result


def _shell_normalize(cmd: str) -> str:
    """Strip shell quoting/substitution/escape layers that fragment token
    matching: 'x', "x", $'x', $(...), and backslash escapes.

    To bash, `rm -r'f' /` is exactly `rm -rf /`. Used by
    check_bash_with_context so recursive-rm detection, target extraction, and
    pattern matching all see the same (normalized) structure — closing the
    bypass where the recursive-rm flag matched but the target extractor could
    not see past the quote fragment, and the command fell through to ALLOW.

    Aggressive stripping is safe here because the normalized form is used
    only for detection/extraction/pattern checks, never for evaluation of
    quoted payloads (those stay opaque on purpose).
    """
    s = cmd
    s = re.sub(r"\$\([^)]*\)", "", s)          # command substitution
    s = re.sub(r"\$'[^']*'", "", s)            # ANSI-C quoting
    s = re.sub(r"'[^']*'", "", s)              # single quotes
    s = re.sub(r'"[^"\\]*(?:\\.[^"\\]*)*"', "", s)  # double quotes
    s = re.sub(r"\\(.)", r"\1", s)             # backslash escapes
    return s


# -- Command splitting --

def _split_commands(cmd: str) -> list[str]:
    """Split command on shell chaining operators (&&, ||, ;, |, newline)
    into individual sub-commands. Each sub-command is checked independently
    to prevent bypasses like "true && rm -rf /".
    """
    # Split preserving | for pipe chains (we check the whole pipe)
    # But split on command separators: &&, ||, ;, newlines
    parts = re.split(r'\s*&&\s*|\s*\|\|\s*|[;&]\s*|\n', cmd)
    return [p.strip() for p in parts if p.strip()]


def _strip_prefix(cmd: str) -> str:
    """Strip privilege elevation and environment prefixes from command."""
    return re.sub(r'^(?:sudo|exec|env|nice|ionice|nohup|command|time)\s+', '', cmd, count=3)


# -- Guard check --

# Patterns that MUST see the whole (un-split) command. Fork bombs and
# alias-definition-then-exec contain ; & | *inside* them, which the
# sub-command splitter would otherwise shred and let through.
_WHOLE_CMD_PATTERNS = [
    # \w{1,64} + {0,256} bounds keep the fork-bomb search linear on
    # adversarial input (see the identical pattern in DANGEROUS_BASH).
    # ^\s* anchor allows leading whitespace (valid bash) without the
    # unbounded \w+ scan that caused the O(n²) blowup.
    (re.compile(r"(?:^\s*|[\n;&|]\s*)\w{1,64}\(\s*\)\s*\{[^}]{0,256}\|[^}]{0,256}&\s*[^}]{0,256}\}", re.I),
     "fork bomb (named func style)"),
    (re.compile(r":\(\s*\)\s*\{", re.I),
     "fork bomb (colon style)"),
    (re.compile(r"\balias\s+\w+=.*;\s*\w+\b", re.I),
     "alias definition then execution"),
]

# Compiled once at import time (was recompiled on every check_bash call)
_BYPASS_PATTERNS = [
    (re.compile(r"\bbase64\s+(?:-d|--decode)(?:(?!\|).){0,2048}\|(?:(?!\b(?:ba)?sh\b).){0,256}(?:ba)?sh\b", re.I),
     "base64 decode pipe to shell"),
    (re.compile(r"\bxxd\s+-r\s+-p(?:(?!\|).){0,2048}\|(?:(?!\b(?:ba)?sh\b).){0,256}(?:ba)?sh\b", re.I),
     "xxd decode pipe to shell"),
    (re.compile(r"\bopenssl\s+(?:base64|enc)\s+-d(?:(?!\|).){0,2048}\|(?:(?!\b(?:ba)?sh\b).){0,256}(?:ba)?sh\b", re.I),
     "openssl decode pipe to shell"),
    # sh -c with encoded content in subshell (before quote stripping)
    (re.compile(r"\bsh\s+-c\s+(?:(?!\$\().){0,256}\$\((?:(?!\b(?:base64|xxd|openssl)\b).){0,256}\b(?:base64|xxd|openssl)\b(?:(?!\s*(?:-d|--decode)\b).){0,256}\s*(?:-d|--decode)(?:(?!\)).){0,256}\)", re.I),
     "sh -c with encoded subshell"),
    # Alternative decoders: python/perl with base64 (before quote stripping)
    (re.compile(r"\b(?:python3?|perl|ruby)\s+-[ce](?:(?!\b(?:base64|MIME::Base64|\.decode\()).){0,2048}\b(?:base64|MIME::Base64|\.decode\()", re.I),
     "scripted base64 decode"),
    # Variable indirection: $VAR containing dangerous paths
    (re.compile(r"\b(?:export\s+)?\w+\s*=\s*(?:rm|dd|mkfs|kill|chmod)\b", re.I),
     "variable assignment of dangerous command"),
    # eval with sub-shell (potential full bypass)
    (re.compile(r"\beval\s+(?:\$\(|`|\")", re.I),
     "eval with substitution (potential bypass)"),
]


def check_bash(command: str, _skip_blanket_rm: bool = False) -> str | None:
    """Check a Bash command against all dangerous patterns.

    Returns the blocking reason if dangerous, None if safe.

    ``_skip_blanket_rm`` is used by check_bash_with_context to route
    non-catastrophic recursive rm to the Asset Ledger instead of the blanket
    block. Level 1 (pattern-only) never sets it, so the blanket stays.
    """
    # First pass: check for bypass patterns (before cleaning — encoded content in quotes)
    for pattern, desc in _BYPASS_PATTERNS:
        if pattern.search(command):
            return f"Dangerous command blocked: {desc}"

    # Whole-command pass: fork bombs / alias-def-exec contain ; & | inside
    # them, so they must be matched before sub-command splitting.
    for pattern, desc in _WHOLE_CMD_PATTERNS:
        if pattern.search(command):
            return f"Dangerous command blocked: {desc}"

    # Split into sub-commands (handles &&, ||, ; chaining bypasses)
    sub_commands = _split_commands(command)

    for sub_cmd in sub_commands:
        # Strip privilege prefixes (sudo, exec, env, etc.)
        stripped = _strip_prefix(sub_cmd)

        # Clean and check each sub-command independently
        cleaned = clean_command(stripped)

        # Blanket recursive-rm block (Level 1 pattern layer). Skipped in
        # context-aware mode so the Asset Ledger can judge non-catastrophic rm.
        if not _skip_blanket_rm and _BLANKET_RECURSIVE_RM.search(cleaned):
            return f"Dangerous command blocked: {_BLANKET_RECURSIVE_RM_DESC}"

        for pattern, desc in COMPILED_DANGEROUS:
            if pattern.search(cleaned):
                return f"Dangerous command blocked: {desc}"

        # Git patterns run on cleaned command
        for pattern, desc in COMPILED_GIT:
            if pattern.search(cleaned):
                return f"Destructive git blocked: {desc}"

    return None


def check_bash_with_context(
    command: str,
    asset_ledger=None,
    error_count: int = 0,
    capability_ledger=None,
) -> dict:
    """Context-aware Bash safety check with tri-state output.

    Recursive rm is NOT short-circuited by the blanket pattern block. Instead:
      1. Catastrophic targets (/, system roots, self-protect) → BLOCK
      1.5. Capability Ledger tracked credential → BLOCK/CONFIRM/ALLOW per state
      2. Asset Ledger tracked → ledger decision (ALLOW/CONFIRM/BLOCK)
      3. Untracked rebuildable/temp (node_modules, dist, /tmp, ...) → ALLOW
      4. Untracked unknown target → CONFIRM
    Only BLOCK scores 100 and locks; CONFIRM never auto-locks.

    Args:
        command: The bash command to check
        asset_ledger: Optional AssetLedger for asset-aware decisions
        error_count: Agent's recent error count (for safe mode)
        capability_ledger: Optional CapabilityLedger for credential-preservation
            gating (blocks removal of a depended-on credential until a verified
            replacement is in place)

    Returns:
        {"decision": "ALLOW"|"CONFIRM"|"BLOCK", "reason": str}
    """
    from paths import is_forbidden_path, is_self_protect_path

    # Shell-normalize first: to bash, `rm -r'f' /` IS `rm -rf /`. Detect
    # recursive rm and extract targets on the normalized form so the
    # fragment-flag bypass (recursive-rm flag matches but the target
    # extractor can't see past the quote fragment → falls through to ALLOW)
    # cannot slip through. Pattern matching also runs on the normalized form
    # so quoted fragments can't hide a catastrophic target.
    normalized = _shell_normalize(command)

    is_recursive_rm = _RECURSIVE_RM_RE.search(normalized) is not None

    # L1: pattern matching. For recursive rm, skip the blanket block so
    # non-catastrophic targets reach the Asset Ledger; catastrophic-target
    # patterns (rm -rf /, ~, project/repo) and self-protect still BLOCK.
    pattern_result = check_bash(normalized, _skip_blanket_rm=is_recursive_rm)
    if pattern_result:
        return {"decision": "BLOCK", "reason": pattern_result}

    # L1.5: paths-based catastrophic check for recursive rm targets that the
    # regex patterns above don't cover (e.g. rm -rf /etc, /usr, /boot).
    if is_recursive_rm:
        m = _RM_TARGET_RE.search(normalized)
        if m:
            target = m.group(1)
            root = is_forbidden_path(target)
            sp = is_self_protect_path(target)
            if root or sp:
                why = f"forbidden root {root}" if root else "self-protect path"
                return {"decision": "BLOCK",
                        "reason": f"recursive rm on {why}: {target}"}

    # L1.6: Capability Ledger — gate removal/relocation of a depended-on
    # credential on a verified replacement. Runs before the Asset Ledger so a
    # credential-dependency BLOCK (runtime would lose capability) takes
    # precedence. Tracked credentials return definitively (incl. ALLOW), so a
    # verified-removable credential is not re-classified by L2/L2.5.
    if capability_ledger is not None:
        cap_result = _check_capability_safety(command, capability_ledger)
        if cap_result:
            return cap_result

    # L2: asset-aware check for tracked assets (rm + mv).
    if asset_ledger is not None:
        asset_result = _check_asset_safety(command, asset_ledger)
        if asset_result:
            return asset_result

    # L2.5: recursive rm on an UNTRACKED target — asset-aware priority.
    # Ledger didn't decide (untracked), so classify by target:
    #   rebuildable/temp → ALLOW ; unknown → CONFIRM.
    if is_recursive_rm:
        m = _RM_TARGET_RE.search(normalized)
        if m:
            target = m.group(1)
            if _REBUILDABLE_RE.search(target):
                return {"decision": "ALLOW",
                        "reason": f"recursive rm on rebuildable/temp asset: {target}"}
            return {"decision": "CONFIRM",
                    "reason": f"recursive rm on untracked target: {target} — confirmation required"}

    # L3: post-error safe mode (only upgrades ALLOW -> CONFIRM, never downgrades BLOCK)
    # If we reached here, Level 1 and Level 2 both passed (would be ALLOW).
    if error_count >= 2 and _is_destructive(command):
        return {
            "decision": "CONFIRM",
            "reason": f"safe_mode: agent has {error_count}+ recent errors",
        }

    return {"decision": "ALLOW", "reason": "safe"}


def _is_destructive(command: str) -> bool:
    """Check if a command is potentially destructive (rm, git destructive, etc.)."""
    return bool(re.search(r"\b(?:rm\s+-[a-zA-Z]*[rf][a-zA-Z]*|git\s+(?:reset|clean|push|checkout|restore))\b", command))


def _check_asset_safety(command: str, ledger) -> Optional[dict]:
    """Check command against the asset ledger for context-aware safety.

    Returns None only for UNTRACKED targets (so check_bash_with_context's L2.5
    can classify them). Tracked assets always return a decision dict — including
    ALLOW, so a tracked+verified asset is not re-classified by L2.5.

    For mv, BOTH sides are checked: the SOURCE is a tracked critical asset
    being relocated (moving a BLOCK-level asset must not silently bypass the
    delete protection), and the DEST may be a tracked asset being overwritten.
    """
    import re as _re

    rm_match = _re.search(r"\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)?(\S+)", command)
    # Two capture groups: source AND destination.
    mv_match = _re.search(r"\bmv\s+(\S+)\s+(\S+)", command)

    is_rm = rm_match is not None
    targets = []
    if rm_match:
        targets.append(rm_match.group(1))
    elif mv_match:
        targets.append(mv_match.group(1))  # source: asset being relocated
        targets.append(mv_match.group(2))  # dest: asset being overwritten

    for target in targets:
        if not ledger.is_tracked(target):
            continue  # untracked side — keep checking / let L2.5 classify

        decision = ledger.is_safe_to_delete(target)
        if "BLOCK" in decision:
            # rm of critical asset -> BLOCK; mv of critical asset (either
            # side) -> CONFIRM — the asset survives, just relocated/overlaid.
            if is_rm:
                return {"decision": "BLOCK", "reason": "asset_ledger: {}".format(decision)}
            return {"decision": "CONFIRM",
                    "reason": "asset_ledger: mv_tracked_asset {}".format(decision.replace("BLOCK:", ":"))}
        elif "CONFIRM" in decision:
            return {"decision": "CONFIRM", "reason": "asset_ledger: {}".format(decision)}

        # tracked + safe (authorized/verified) → ALLOW (do not fall through to L2.5)
        return {"decision": "ALLOW", "reason": "asset_ledger: {}".format(decision)}

    return None  # no tracked target on either side


def _check_capability_safety(command: str, capability_ledger) -> Optional[dict]:
    """Gate removal/relocation of a depended-on credential on a verified
    replacement (Capability Ledger). Returns None if no tracked credential is
    targeted; otherwise returns the ledger's decision definitively (incl.
    ALLOW, so a verified-removable credential is not re-classified by L2/L2.5).
    """
    import re as _re

    # rm: target is the credential being deleted (with or without -r flag).
    rm_match = _re.search(r"\brm\b\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)?(\S+)", command)
    # mv: SOURCE is the credential being relocated.
    mv_match = _re.search(r"\bmv\s+(\S+)\s+\S+", command)
    # truncate / clear / redirect-to-empty: target being cleared.
    trunc_match = _re.search(
        r"(?:\btruncate\b\s+-s\s+0\s+|:\s*>\s*|\bcp\s+/dev/null\s+|>>?\s*)(\S+)",
        command,
    )

    targets = []
    if rm_match:
        targets.append(rm_match.group(1))
    if mv_match:
        targets.append(mv_match.group(1))
    if trunc_match:
        targets.append(trunc_match.group(1))

    for target in targets:
        if capability_ledger.is_tracked(target):
            decision = capability_ledger.removal_decision(target)
            if "BLOCK" in decision:
                return {"decision": "BLOCK", "reason": f"capability_ledger: {decision}"}
            if "CONFIRM" in decision:
                return {"decision": "CONFIRM", "reason": f"capability_ledger: {decision}"}
            # tracked + removable → ALLOW (definitive; do not fall through)
            return {"decision": "ALLOW", "reason": f"capability_ledger: {decision}"}

    return None  # no tracked credential targeted

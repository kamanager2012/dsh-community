#!/bin/bash
# install.sh �� ACS Multi-Agent Installer
# ./install.sh           Interactive menu
# ./install.sh --all     Install everything detected
# ./install.sh claude    Install specific agent
# ./install.sh --verify  Check status
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
CORE_SRC="$REPO_ROOT/acs_core"
CORE_DST="$HOME/.acs_core"

R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[1;36m' D='\033[2m' N='\033[0m'

AGENTS=(claude codex gemini cursor opencode qoder hermes grok codebuddy)
declare -A NAME DIR HOOKS INIT ICON

NAME["claude"]="Claude Code";         DIR["claude"]="$HOME/.claude"
NAME["codex"]="Codex CLI (OpenAI)";   DIR["codex"]="$HOME/.codex"
NAME["gemini"]="Gemini CLI (Google)"; DIR["gemini"]="$HOME/.gemini"
NAME["cursor"]="Cursor";             DIR["cursor"]="$HOME/.claude"
NAME["opencode"]="OpenCode";          DIR["opencode"]="$HOME/.opencode"
NAME["qoder"]="Qoder CN";            DIR["qoder"]="$HOME/.qoder-cn"
NAME["hermes"]="Hermes Agent";       DIR["hermes"]="$HOME/.hermes"
NAME["grok"]="Grok Build (xAI)";     DIR["grok"]="$HOME/.grok"
NAME["codebuddy"]="CodeBuddy Code";    DIR["codebuddy"]="$HOME/.codebuddy"

HOOKS["claude"]="$HOME/.claude/hooks"
HOOKS["codex"]="$HOME/.codex/hooks"
HOOKS["gemini"]="$HOME/.gemini/hooks"
HOOKS["cursor"]="$HOME/.cursor/hooks"
HOOKS["opencode"]="$HOME/.opencode"
HOOKS["qoder"]="$HOME/.qoder-cn/hooks"
HOOKS["hermes"]="$HOME/.hermes/hooks"
HOOKS["grok"]="$HOME/.grok/hooks"
HOOKS["codebuddy"]="$HOME/.codebuddy/hooks"

INIT["claude"]="python3 ~/.claude/hooks/acs_claude.py init"
INIT["codex"]="python3 ~/.codex/hooks/acs_codex.py init"
INIT["gemini"]="python3 ~/.gemini/hooks/gacs.py init"
INIT["qoder"]="python3 ~/.qoder-cn/hooks/qacs.py init"
INIT["hermes"]="python3 ~/.hermes/agent-hooks/hacs.py init"
INIT["codebuddy"]="python3 ~/.codebuddy/hooks/acs_codebuddy.py init"
INIT["grok"]="python3 ~/.grok/hooks/acs_grok.py init"
INIT["cursor"]="python3 ~/.cursor/hooks/acs_cursor.py init"

detected() { [[ -d "${DIR[$1]}" ]]; }

install_core() {
install_core() {
    mkdir -p "$CORE_DST"
    cp "$CORE_SRC"/*.py "$CORE_DST/" 2>/dev/null
    local n=$(ls "$CORE_DST"/*.py 2>/dev/null | wc -l)
    echo "  OK: Core -- ${n} files installed to $CORE_DST"
}
}

install_claude() {
    mkdir -p "${HOOKS[claude]}"
    cp "$REPO_ROOT/adapters/claude/acs_claude.py" "${HOOKS[claude]}/"
}
install_codex() {
    mkdir -p "${HOOKS[codex]}"
    cp "$REPO_ROOT/adapters/codex/acs_codex.py" "${HOOKS[codex]}/"
    cp "$REPO_ROOT/adapters/codex/hooks.json" "$HOME/.codex/"
    grep -q 'hooks\s*=\s*true' "$HOME/.codex/config.toml" 2>/dev/null || \
        echo -e "\n[features]\nhooks = true" >> "$HOME/.codex/config.toml"
}
install_gemini() {
    mkdir -p "${HOOKS[gemini]}"
    cp "$REPO_ROOT/adapters/gemini/gacs.py" "${HOOKS[gemini]}/"
    cp "$REPO_ROOT/adapters/gemini/settings.json" "$HOME/.gemini/"
}
install_cursor() {
    mkdir -p "${HOOKS[cursor]}"
    cp "$REPO_ROOT/adapters/cursor/acs_cursor.py" "${HOOKS[cursor]}/"
}
install_opencode() {
    echo "  OpenCode: TypeScript plugin at adapters/opencode/"
}
install_qoder() {
    mkdir -p "${HOOKS[qoder]}"
    cp "$REPO_ROOT/adapters/qoder/qacs.py" "${HOOKS[qoder]}/"
}
install_hermes() {
    mkdir -p "$HOME/.hermes/agent-hooks"
    cp "$REPO_ROOT/adapters/hermes/hacs.py" "$HOME/.hermes/agent-hooks/"
    cp "$REPO_ROOT/adapters/hermes/hooks.yaml" "$HOME/.hermes/"
}
install_codebuddy() {
    mkdir -p "${HOOKS[codebuddy]}"
    cp "$REPO_ROOT/adapters/codebuddy/acs_codebuddy.py" "${HOOKS[codebuddy]}/"
}
install_grok() {
    mkdir -p "${HOOKS[grok]}"
    cp "$REPO_ROOT/adapters/grok/acs_grok.py" "${HOOKS[grok]}/"
}

install_grok_tbd() { :; }  # replaced by above

show_menu() {
    echo -e "\n  Select agents to protect:\n"
    local idx=1
    for agent in "${AGENTS[@]}"; do
        local status=""
        detected "$agent" && status="${G}detected${N}" || status="${D}not found${N}"
        printf "  %s) %-22s %s\n" "$idx" "${NAME[$agent]}" "$status"
        ((idx++))
    done
    echo ""
    printf "  a) All detected\n  q) Quit\n\n"
    read -r -p "  Enter numbers (e.g. 1 3 6) or 'a': " selection
    [[ "$selection" == "q" ]] && { echo "Cancelled."; exit 0; }
    if [[ "$selection" == "a" ]]; then
        for a in "${AGENTS[@]}"; do detected "$a" && echo "$a"; done
        return
    fi
    for num in $selection; do
        [[ "$num" =~ ^[1-8]$ ]] && echo "${AGENTS[$((num-1))]}"
    done
}

# ---- main ----
case "${1:-}" in
    --verify)
        echo ""; for a in "${AGENTS[@]}"; do
            detected "$a" && echo -e "  ${G}OK${N} ${NAME[$a]}" || echo -e "  ${D}--${N} ${NAME[$a]}"
        done; echo ""; exit 0 ;;
    --list)
        for a in "${AGENTS[@]}"; do printf "  %-22s %s\n" "$a" "${NAME[$a]}"; done; exit 0 ;;
esac

TARGETS=()
if [[ "${1:-}" == "--all" ]] || [[ "${1:-}" == "all" ]]; then
    for a in "${AGENTS[@]}"; do detected "$a" && TARGETS+=("$a"); done
elif [[ $# -gt 0 ]]; then
    TARGETS=("$@")
else
    mapfile -t TARGETS < <(show_menu)
fi

[[ ${#TARGETS[@]} -eq 0 ]] && { echo "Nothing selected."; exit 0; }

echo -e "\n${B}  ACS Multi-Agent Constraint System${N}"
echo "  ================================"
echo ""
install_core
echo ""
for agent in "${TARGETS[@]}"; do
    "install_$agent" 2>/dev/null || true
    echo -e "  ${G}OK${N} ${NAME[$agent]}"
done
echo ""
echo "  Done. Initialize each agent:"
for agent in "${TARGETS[@]}"; do
    [[ -n "${INIT[$agent]:-}" ]] && echo "    ${NAME[$agent]}: ${INIT[$agent]}"
done
echo ""

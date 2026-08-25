# Upstream Breaking Changes & Mitigation Log

| Upstream Version | Breaking Surface | Impact | Bridge Mitigation |
| :--- | :--- | :--- | :--- |
| `0.1.0-rc.6` → `rc.7` | `session/event` payload rename: `thought` → `reasoning_content` | TUI stream reasoning blank | Normalized via `dsh-bridge/event-stream.ts` |
| `0.1.0-rc.7` → `rc.8` | `approval.required` moved to tool level | Tool execution bypasses approval | Normalized via `DshToolCall.riskLevel` & `registerApproval` |
| `0.1.0-rc.7` → `rc.8` | SQLite internal storage schema incompatible rewrite | Legacy SQLite fork failure | Read-Only segregation via `~/.dsh/suite_sessions` |
| `0.1.0-rc.8` → `rc.1` | Multimodal model alias & Bubblewrap procfs restriction | Vision model selection & sandbox escape | Added `DeepSeek-V4-Flash-Vision-Exp` to preset router |
| `0.1.1-rc.1` → `rc.2` | Files API pipeline for image attachments | Base64 oversized attachment request failures | Transparent Files API payload resolver normalization |

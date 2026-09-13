# Upstream Breaking Changes & Mitigation Log

| Upstream Version | Breaking Surface | Impact | Bridge Mitigation |
| :--- | :--- | :--- | :--- |
| `0.1.0-rc.6` → `rc.7` | `session/event` payload rename: `thought` → `reasoning_content` | TUI stream reasoning blank | Normalized via `dsh-bridge/event-stream.ts` |
| `0.1.0-rc.7` → `rc.8` | `approval.required` moved to tool level | Tool execution bypasses approval | Normalized via `DshToolCall.riskLevel` & `registerApproval` |

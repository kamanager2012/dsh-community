## Description

Briefly describe the purpose of this PR and what problem it solves.

## Architectural Checklist

- [ ] **Official Source Ownership = 0**: No official `@deepseek-ai/dsh` code has been vendored or modified.
- [ ] **Session Storage Safety**: Suite sessions are stored in `~/.dsh/suite_sessions/`; official `~/.dsh/sessions/` is untouched.
- [ ] **Process Lifecycle**: Clean child process tree teardown is maintained on exit and signals.
- [ ] **TypeScript Build**: `pnpm run build` (or `tsc --build`) passes with 0 errors.
- [ ] **Test Coverage**: All unit & contract tests pass (`pnpm run test`).
- [ ] **Dynamic Contract CI**: `npx tsx scripts/contract-checker.ts` passes against official upstream.

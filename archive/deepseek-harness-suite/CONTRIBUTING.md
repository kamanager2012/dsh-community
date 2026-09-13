# Contributing to DeepSeek Harness Suite

Thank you for your interest in contributing to **DeepSeek Harness Suite**!

## Core Architectural Invariants

Before submitting any Pull Request, please ensure your changes adhere to our core principles:

1. **Official Source Ownership = 0**: Never copy, fork, or vendor official `@deepseek-ai/dsh` code into this repository. Upstream packages must be invoked as external runtimes.
2. **Session Storage Safety**: Never write non-standard custom files directly into `~/.dsh/sessions/`. Keep official sessions read-only; use `~/.dsh/suite_sessions/` for Suite state.
3. **Automated Contract CI Gate**: All PRs must pass the dynamic contract checker:
   ```bash
   npx tsx scripts/contract-checker.ts
   ```

## Local Development Workflow

```bash
# 1. Install dependencies
pnpm install

# 2. Build monorepo packages
pnpm run build

# 3. Run all unit and contract test suites
pnpm run test

# 4. Run dynamic upstream contract probe
npx tsx scripts/contract-checker.ts
```

## Pull Request Checklist

- [ ] `pnpm run build` succeeds with 0 TypeScript errors.
- [ ] `pnpm run test` passes all test suites.
- [ ] `npx tsx scripts/contract-checker.ts` passes against official DSH.
- [ ] Code changes maintain clean process lifecycle and signal handling.

# Contributing to governor-core

Thanks for helping make agent governance actually enforce. This is a
security-enforcement tool, so correctness and fail-closed behavior come first.

## Ground rules

- **Fail closed.** Any new decision path must default to `deny` on error or
  ambiguity, never `allow`.
- **Deterministic core.** No network or model calls in the decision path. The
  same `ToolCall` must always yield the same `Verdict`.
- **Zero runtime dependencies.** The core uses only the Node.js standard library.
  Dev dependencies (test/build tooling) are fine.
- **Every enforcement change ships with tests** — ideally an entry in
  `tests/adversarial.test.ts` for anything bypass-related.

## Development

```bash
npm install
npm test           # vitest: scope, engine, hook, concurrency, adversarial
npm run build      # tsc type-check + emit dist/
```

Please make sure `npm test` and `npm run build` both pass before opening a PR.

## Reporting a bypass

If you found a way to get a dangerous action *allowed*, that's a security issue —
follow [SECURITY.md](./SECURITY.md) rather than opening a public issue. For a
fix, add the technique to `tests/adversarial.test.ts` so it can never regress.

## Pull requests

- Keep changes focused; one logical change per PR.
- Match the existing code style (TypeScript, ESM, strict mode).
- Update `README.md` / `CHANGELOG.md` when behavior or the public API changes.
- Explain the *why* in the PR description, especially for policy changes.

## Adding an adapter

Adapters live under `src/adapters/<host>/` and translate a host agent's native
payload into the agent-agnostic `ToolCall`, then map the `Verdict` back to the
host's protocol. Keep host-specific quirks (and blind spots) documented in the
adapter file, as the Claude Code hook adapter does.

## Code of Conduct

By participating you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache-2.0](./LICENSE) license.

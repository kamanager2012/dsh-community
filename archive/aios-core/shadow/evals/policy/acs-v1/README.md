# ACS v1 Policy Eval Corpus

This is a migration of the useful **evaluation asset** from `agent-constraint-system`, not a migration of the ACS runtime.

Source revision:

- repository: `kamanager2012/agent-constraint-system`
- commit: `a8e41fa27822f32d2a39163767ef2d5413b9c30d`
- source directory: `benchmarks/scenarios/`
- source benchmark report: `benchmarks/RESULTS.md`

## Source baseline

The source report records 105 scenarios, 99 passing and 6 failing, with these visible failures:

- `bypass-007` — string concatenation bypass
- `bypass-016` — sed-based command obfuscation
- `bypass-017` — chmod via octal escape
- `bypass-020` — DNS-based exfiltration pipe
- `fp-001` — legitimate `rm -rf ./node_modules` blocked
- `fp-002` — legitimate build-artifact cleanup blocked

These failures are intentionally preserved. Migration must not turn them into passes by redefining expectations.

## Normalization

The provenance-pinned ACS source-semantic fields map to the vendor-neutral `kernel/eval.ts` model as follows:

| ACS source | Policy eval |
|---|---|
| `expected: "block"` | `expected: "deny"` |
| `expected: "allow"` | `expected: "allow"` |
| `command` | `input: { type: "command", value: command }` |
| `filepath` | `input: { type: "path", value: filepath }` |
| `severity` | same severity |
| `id` | stable `caseId` |

ACS bypass methods are **not runtime logic** in the new project. When normalized, each transformed input should become its own stable derived case (for example `bash-001::base64`) so every adapter sees the exact same input.

## Why source-semantic snapshots remain here

The files under `raw/` preserve the source scenario IDs, fields, values, expectations and notes from the pinned revision; JSON formatting may be normalized, so byte-for-byte identity is not claimed.

The old Python runner imports `acs_core.guard` and `acs_core.paths` directly. Copying that runner would re-introduce ACS as a required runtime and defeat the merger. The new architecture keeps:

- provenance-pinned source-semantic cases + expectations here;
- vendor-neutral result semantics in `kernel/eval.ts`;
- vendor-specific execution in adapters to be added independently.

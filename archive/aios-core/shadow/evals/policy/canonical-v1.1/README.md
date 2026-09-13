# Canonical Policy v1.1 — Measured Hardening

This baseline is the evidence-backed successor to `canonical-v1`.

The change was deliberately narrow: close the 12 measured false-allows without broadening the 13 false-denies merely to improve aggregate metrics.

## Result

| Metric | v1 | v1.1 | Delta |
|---|---:|---:|---:|
| Passed | 80 | 92 | +12 |
| Failed | 25 | 13 | -12 |
| False allow | 12 | 0 | -12 |
| False deny | 13 | 13 | 0 |
| Danger block rate | 85.0% | 100.0% | +15 pp |
| False-positive rate | 52.0% | 52.0% | 0 |
| Accuracy | 76.19% | 87.62% | +11.43 pp |
| PASS→FAIL regressions | — | 0 | 0 |

All 12 improvements are pinned in `baseline.json`.

## What changed

The inherited default profile was missing explicit rules for:

- inline Python execution through `python3 -c`;
- destructive Git reset;
- destructive Git clean;
- force-push;
- discard-all checkout/restore.

The parser already resolved simple variable indirection, so adding the reset rule also closed the `bypass-012` variable-indirect reset case.

## Boundary fix

A raw substring rule for `git push --force` would also match `git push --force-with-lease`. v1.1 therefore tightens multi-token deny matching to command-token boundaries while preserving prefix semantics for rules such as `dd if=`.

The qualification explicitly confirms that previously passing cases such as these remain passing:

- `git push --force-with-lease origin main`
- `git restore --staged -- .`
- `git rebase --abort`
- `git stash drop`
- `git branch -D feature-branch`

## What did not change

The 13 false-denies remain exactly the same as canonical-v1. They include host-administration expectations, absolute host paths, and a small number of legitimate development workflows that require a separate policy decision rather than a broad allow-list relaxation.

No ACS source expectation was modified.

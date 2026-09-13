## Summary

One paragraph: what changed and why.

## Type of change

- [ ] fix (behavior change in detection/policy)
- [ ] feat (new capability)
- [ ] docs
- [ ] test (benchmark scenarios)
- [ ] refactor

## Verification

- [ ] `python3 -m pytest tests/ -q` passes
- [ ] `benchmarks/runner.py` (Level 1) does not regress — state before/after pass counts
- [ ] If detection logic changed: new scenario(s) added that exercise the change
- [ ] If `guard.py` patterns changed: patterns are bounded (no unbounded `.*`/`\w+` — ReDoS resistance)

## Known gaps / follow-ups

Anything intentionally left out, or open questions.

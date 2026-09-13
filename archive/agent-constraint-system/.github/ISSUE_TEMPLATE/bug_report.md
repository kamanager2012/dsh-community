---
name: Bug report
about: A constraint was bypassed, or a legitimate command was blocked
title: "[bug] "
labels: bug
assignees: ''

---

**What happened**
A one-paragraph description of the incorrect behavior.

**Was a constraint bypassed or a false positive?**
- [ ] Bypass — something dangerous was allowed
- [ ] False positive — something legitimate was blocked

**Minimal reproduction**
The exact command or write action, and the agent/OS environment:

```bash
# the command that was checked
```

**Expected vs actual**
- Expected: `block` / `allow`
- Actual: what ACS returned

**Environment**
- ACS version (`acs version` or `VERSION` file):
- Agent: (Claude Code / Codex CLI / ...)
- OS:

**Benchmark**
If you can, add the reproduction as a scenario in `benchmarks/scenarios/` —
see [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-benchmark-scenario).

# Agent Constraint System (Legacy)

> **Status: Legacy / superseded.** New development has moved to [AIOS Core](https://github.com/kamanager2012/aios-core), the canonical Agent Reliability / Agent CI project.

Agent Constraint System (ACS) was the original command- and path-level execution-governance project used to explore deterministic guardrails for coding agents.

It is no longer the recommended integration point for new work.

## Where active development moved

The useful parts of this project have been carried forward into **AIOS Core**:

- the Level-1 policy evaluation corpus and known-failure baseline;
- command/path policy semantics used for vendor-neutral reliability evaluation;
- regression-oriented qualification rather than standalone regex-firewall positioning;
- provenance for historical bypasses and false positives.

AIOS Core now owns the canonical direction:

```text
Task Contract
    ↓
Agent / Model / Vendor Runtime
    ↓
Evidence
    ↓
Reliability Verdict
    ↓
Replay + Regression
```

Native agent runtimes and OS sandboxes should own actual execution isolation. AIOS owns task-outcome evidence, policy semantics, replay, and cross-version regression.

**Canonical repository:** https://github.com/kamanager2012/aios-core

## What remains here

This repository is retained as a historical source for:

- the original ACS runtime and adapters;
- Levels 1–4 benchmark material;
- threat-model experiments;
- historical implementation decisions and known gaps.

These artifacts remain useful as provenance and research material, but they should not be treated as the current product architecture.

## Maintenance policy

- No new agent integrations should target ACS as a standalone runtime.
- No new product features are planned here.
- Historical corrections or critical repository-maintenance fixes may still be accepted.
- New reliability, policy-evaluation, replay, and vendor-adapter work belongs in **AIOS Core**.

For the current architecture, start with the [AIOS Core README](https://github.com/kamanager2012/aios-core#readme).

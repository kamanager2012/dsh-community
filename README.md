# governor-core (Legacy)

> **Status: Legacy / superseded.** New development has moved to [AIOS Core](https://github.com/kamanager2012/aios-core), the canonical Agent Reliability / Agent CI project.

`governor-core` was the original deterministic policy and accountability layer for AI coding agents. It explored `ToolCall → allow / deny / ask`, scope validation, approvals, and hash-chained audit semantics.

It is no longer the recommended integration point for new work.

## Where active development moved

The reusable policy ideas from this repository have been absorbed into **AIOS Core** as vendor-neutral policy semantics and reliability gates:

- strict policy schema validation and deterministic normalization;
- project-relative path and command-scope semantics;
- command-chain, substitution, variable-indirection, write-target, and mass-delete analysis;
- explicit acknowledgement that these semantics are not an OS security boundary;
- evidence-driven acceptance and regression instead of a standalone policy-engine product.

AIOS deliberately did **not** copy the old `GovernanceEngine` as a second runtime. Native agent runtimes and OS sandboxes should own execution isolation; AIOS owns unified semantics, task evidence, replay, qualification, and regression.

**Canonical repository:** https://github.com/kamanager2012/aios-core

## What remains here

This repository is retained as a historical source for:

- the original policy engine and approval flow;
- adversarial scope/parser tests;
- audit-chain and anchoring experiments;
- threat-model documentation and residual-gap analysis.

These artifacts remain useful as implementation provenance, but they should not be treated as the current product architecture.

## Maintenance policy

- No new vendor integrations should target `governor-core` as a standalone policy runtime.
- No new product features are planned here.
- Historical corrections or critical repository-maintenance fixes may still be accepted.
- New policy semantics, evidence gates, replay, qualification, and vendor-adapter work belongs in **AIOS Core**.

For the current architecture, start with the [AIOS Core README](https://github.com/kamanager2012/aios-core#readme).

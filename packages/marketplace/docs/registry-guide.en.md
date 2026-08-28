# Plugin Registry and Verification Guide

[简体中文](registry-guide.md) · [Back to package README](../README.md) · [Online Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/en/)

## What this catalog owns

`packages/marketplace/catalog.json` is the public Compatibility Registry. It records where a plugin comes from, which version was tested against which official DSH Runtime line, and which status Marketplace should show.

It does not:

- execute an Agent or implement a Runtime;
- replace the official `dsh plugin add` install chain;
- treat an author README as security or compatibility proof;
- store user Sessions, credentials, or plugin runtime data.

## Entry shape

Entries in `catalog.json` should provide:

| Field | Requirement |
| --- | --- |
| `name` | Package name accepted by official `dsh plugin add <name>` |
| `description` | Short, checkable, non-inflated description |
| `author` | Author or organization |
| `repo` | Public source URL |
| `category` | `ui`, `tool`, `provider`, `workflow`, or `other` |
| `versions[].version` | Tested plugin version |
| `versions[].testedDsh` | Official Runtime line actually used |
| `versions[].notes` | Facts from install, composition, or runtime smoke tests |
| `versions[].security` | Structured security metadata, see "Security metadata" below |

`testedDsh` links evidence; it is not a promise of permanent compatibility. A version without a matching Runtime line must be shown as `[UNVERIFIED]`.

## Security metadata

`versions[].security` gives a structured permission disclosure for every listed version, instead of relying on the author's README or claims to judge whether a plugin is safe. `scripts/verify.mjs` validates its shape; a missing or malformed field fails CI. Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `network` | string | Network behavior the plugin initiates or listens on; write "none" if there is none |
| `dataEgress` | string | What data leaves the local machine, and where it goes |
| `credentials` | string | Credentials/keys the plugin accesses, stores, or requires |
| `filesystem` | string | File reads/writes outside the plugin's own install directory |
| `processExecution` | string | Whether it spawns subprocesses, calls external binaries, or intercepts/rewrites other tool calls |
| `persistence` | string | Where state survives a restart or across sessions |
| `risk` | `"low"` \| `"medium"` \| `"high"` | Overall risk level |
| `requiresConfirmation` | boolean | Whether install should prompt an explicit user confirmation; must be `true` whenever `risk` is not `low` (enforced by CI) |
| `manualReviewStatus` | `"unreviewed"` \| `"partial"` \| `"reviewed"` | How thoroughly this disclosure itself has been checked by a human; **this is about the disclosure, not an independent dynamic security test of the plugin**, and is a separate axis from the top-level `[VERIFIED]`/`[PARTIAL]`/`[UNVERIFIED]` compatibility status |
| `manualReviewNote` | string | The concrete evidence behind the assessment (e.g. which part of the author's README was used) |
| `lastReviewedAt` | string (`YYYY-MM-DD`) | Date this security metadata was last reviewed |

For the six descriptive fields (`network`, `dataEgress`, `credentials`, `filesystem`, `processExecution`, `persistence`), write "none" explicitly when there is no such behavior — do not leave them empty. CI rejects empty strings because "not written" and "checked, and confirmed absent" are different claims.

When adding or updating an entry, the `security` content must come from actually reading the plugin's source or README, not from guessing. If there isn't enough information to judge a dimension, keep `manualReviewStatus` at `unreviewed` and explain the missing evidence in `manualReviewNote` instead of writing a plausible-sounding guess.

## Verification ladder

```text
existence
  → install
  → compose
  → runtime smoke
  → package digest
  → provenance
  → DSH compatibility matrix
```

Declare only the level that has evidence. Catalog size cannot replace verification depth; a reachable GitHub page or an author README is not a successful runtime test.

Recommended evidence for each entry:

- package and public repository still exist;
- official installation succeeds against the specified Runtime version;
- composition with the base profile does not break startup;
- a minimal runtime smoke test with command, exit code, and result;
- version, digest, or immutable commit;
- Runtime line and last verification date.

## Submission flow

1. Prepare public installation instructions and a minimal smoke test in the plugin repository;
2. Add an entry to `catalog.json` with consistent fields and naming, including `versions[].security` (see above; `node scripts/verify.mjs --offline` validates its shape);
3. Include the Runtime version, install command, and result in the Pull Request;
4. Let maintainers review the evidence and the security metadata without turning unknown fields into guarantees;
5. Marketplace reads the registry, while installation returns to official `dsh plugin add`.

## Status shown to users

| Status | Meaning | Safe handling |
| --- | --- | --- |
| `[VERIFIED]` | Runtime line and install/composition/runtime evidence exist | Users must still review plugin permissions |
| `[PARTIAL]` | Some evidence exists, such as install without runtime smoke coverage | Do not claim runtime compatibility |
| `[UNVERIFIED]` | No matching Runtime line or evidence is stale | Treat as unknown by default |
| `[INCOMPATIBLE]` | Known incompatibility with the current Runtime line | Do not recommend by default |

This table describes **compatibility** evidence, a separate axis from `security.manualReviewStatus`, which describes how thoroughly the **security disclosure** has been checked: a `[VERIFIED]` plugin can still be `risk: high`. The `security` fields do not decide whether a plugin is trustworthy for you; for plugins that access the network, files, processes, credentials, or system mutation, read the source and permission notes separately.

## Ecosystem links

- [Canonical Product: dsh-community](https://github.com/kamanager2012/dsh-community)
- [Archived Labs](https://github.com/kamanager2012/deepseek-harness-suite) (do not install from there)
- [Marketplace CLI](../README.md)
- [Handbook plugin section](https://kamanager2012.github.io/deepseek-harness-handbook/en/10-plugins/)
- [Official Runtime](https://github.com/deepseek-ai/deepseek-harness)

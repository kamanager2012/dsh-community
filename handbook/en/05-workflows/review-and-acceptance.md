# Review and acceptance design

## Acceptance is not a final “please confirm”

Write acceptance into the task contract before the task starts, then execute it with
commands, tests, or human steps outside the Agent. Good acceptance is:

- observable;
- repeatable;
- directly related to the goal;
- able to locate a failure;
- independent of the model's self-report.

## Three kinds of acceptance

### Machine acceptance

Tests, builds, type checks, lint, schema validation, `git diff --check`, and file hashes.
Use these for requirements with a deterministic result.

### Structural acceptance

Check file scope, dependency changes, configuration fields, API compatibility, logs, and
generated files. This prevents a task from “working” while expanding beyond its scope.

### Human acceptance

Check design trade-offs, user experience, privacy, business meaning, and risks that
cannot be expressed automatically. Human acceptance should review the actual diff,
result, and constraints, not only the Agent's final answer.

## Stage acceptance table

| Stage | Input | Check | Pass condition |
| --- | --- | --- | --- |
| Understand | task and workspace | scope and baseline | invariants can be explained |
| Plan | proposed approach | impact and permissions | actions can be rolled back |
| Change | diff | files and dependencies | within the allowed scope |
| Test | command | exit code and log | relevant checks pass |
| Deliver | report | complete or incomplete | risks and recovery are explicit |

## Failure states

At minimum, distinguish:

- `completed`: the goal and external acceptance both passed;
- `partial`: part of the goal is complete and the remainder is explicit;
- `failed`: a critical step failed;
- `blocked`: credentials, permissions, environment, or a human decision is missing;
- `needs-review`: automated checks passed but business judgment is still required.

Do not rewrite `blocked` as `completed`. Accurate status matters more than a better-looking
report.

## Review checklist

~~~bash
git status --short
git diff --name-only
git diff --stat
git diff --check
~~~

Then run the checks relevant to the project. For a non-Git workspace, use a checklist,
hashes, and a temporary copy.

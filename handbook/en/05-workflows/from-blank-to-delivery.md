# Main workflow: from an empty workspace to an accepted delivery

This is the main English workflow. It divides an agent task into stages that can be
paused, reviewed, and recovered: establish a baseline, understand without writing,
make the smallest change, and accept the result with external checks.

This is a repeatable operating tutorial, not an execution report. Commands, exit codes,
file changes, and model behavior must be produced by your own checkout.

## What you will do

Use a disposable or recoverable project copy and complete this loop:

```text
prepare the environment
  → establish a baseline
  → understand the project read-only
  → write a minimal plan
  → allow a limited change
  → run independent checks
  → inspect diff and side effects
  → deliver, recover, or stop
```

Suitable first tasks include reproducing a test failure, adding a small feature with a
test, migrating an old installation instruction, or mapping an unfamiliar repository.
Do not use a production directory, customer data, or the only copy of an uncommitted
workspace.

## Stage 0: prepare a recoverable scene

Confirm that dsh starts, the installed version explains its parameters, the Provider
and model are configured without putting a secret in the task, and the workspace is a
temporary checkout, branch, or recoverable copy.

Run a baseline before submitting the task:

```bash
node --version
npx @deepseek-ai/dsh --help
git status --short
git diff --stat
```

Record the dsh version or source commit, runtime versions, Provider/model, workspace,
initial status, initial checks, and network policy.

## Stage 1: understand without changing

Start with a read-only task:

```text
Goal: describe the stack, entry points, main modules, test commands, and files relevant to this task.
Scope: read only the selected workspace; start with README files, package manifests, entry points, and related tests.
Do not: create, modify, or delete files; install dependencies; use the network; or access paths outside the workspace.
Evidence: cite file paths and separate observations, inferences, and uncertainty.
Stop: ask before writing, installing, using credentials, using the network, or expanding the path scope.
Delivery: provide a project map, candidate files, test entry points, risks, and the next suggested step.
```

After the run, check `git status --short` and `git diff --stat`. Verify the workspace,
cited paths, tool behavior, installation/network activity, and the distinction between
facts and inferences. Preserve an unexpected diff until its cause is known.

## Stage 2: narrow the request into a minimal plan

State the goal, allowed files, prohibited changes, invariants, steps, acceptance
commands, and stop conditions before enabling writes:

```text
Goal: fix [reproducible failure] / add [one feature] / migrate [one document path].
Allowed: [explicit files or directories]
Not allowed: unrelated dependencies, tests, release settings, or paths outside the workspace.
Invariant: keep [public interface/data format/existing behavior] unchanged.
Acceptance: [command 1], [command 2], git diff --check, and a human diff review.
Stop: pause before expanding scope, using the network, installing, or requesting higher privilege.
```

A plan is not a completion result and it does not replace approval.

## Stage 3: allow only the smallest change

Before each approval, confirm the path, generated files, network or credential use,
and the relationship to the original goal. For a change task, tell the agent to:

```text
Implement only the approved plan.
After each independent change, explain what changed and run the next verification command.
If verification fails, preserve the failure and report where it happened.
Do not delete tests, weaken assertions, upgrade unrelated dependencies, or commit changes.
```

Break large work into independently reviewable changes with their own checks.

## Stage 4: accept with external checks

Start with cheap, local, explainable checks:

```bash
git diff --check
git diff --stat
git diff --name-only
# Run the project's relevant tests, type checks, or build.
git status --short
```

Separate facts: changed files, test output and exit codes, scope compliance, generated
files/dependencies, and business acceptance. A final agent summary cannot replace any
of these.

## Stage 5: deliver or recover

A minimum delivery report states the status, goal, changed files, root cause or design
trade-offs, commands and exit codes, external acceptance, unresolved issues, security
notes, rollback path, and session/checkpoint reference.

If the task fails: stop running agents and shells, preserve status/diff/log references,
confirm workspace/session/model/permissions, return to the last explainable checkpoint,
then choose continue, fork, new session, rollback, or stop. If the old session may carry
bad context, create a new one rather than copying only its ID.

## Completion checklist

- [ ] A baseline was established in a recoverable workspace.
- [ ] A read-only task confirmed path, tools, and model.
- [ ] Goal, scope, invariants, permissions, acceptance, and stop conditions were explicit.
- [ ] Each change mapped to an allowed path and checkpoint.
- [ ] External commands, diff, or human review proved the result.
- [ ] Failure could be preserved and resumed, recovered, or stopped.
- [ ] The delivery report separated facts, inferences, skipped checks, and remaining risks.

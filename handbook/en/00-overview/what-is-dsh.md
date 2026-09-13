# What is dsh?

## One-sentence definition

DeepSeek Harness, commonly invoked as `dsh`, is an open-source harness for running
agent tasks. It assembles model requests, tools, workspaces, sessions, permissions,
approvals, and a user interface into a sustained task instead of returning only a
single chat response.

The upstream project describes itself as an “everything is a plugin” system powered by
Cordis. This matters: the Web UI, headless runner, model adapters, tool registry,
session storage, sandbox, and approval policy are composable capabilities rather than
one irreplaceable monolith.

## It is not just a one-shot model call

A normal API call is often:

```text
input message → HTTP request → text response
```

A typical dsh task is closer to:

```text
user goal
  → choose a model and Provider
  → choose a profile and composition
  → open a session
  → read the workspace and context
  → plan the next step
  → request the model
  → call tools
  → receive tool results
  → continue a turn or stop
  → save events, results, and the exit reason
```

This makes longer work possible, but it also creates boundaries that a person must
manage:

- Which directories can the agent access?
- Which tool calls require approval?
- What input will the Provider receive?
- Does a session carry old shell state?
- What external result proves that the task is complete?
- Did an upgrade change the default tools or permissions in a profile?

## dsh, models, Providers, and agents

| Object | What it does | What it does not guarantee |
| --- | --- | --- |
| Model | Generates the next decision, text, or tool-call intent | Permission, factual correctness, or task completion |
| Provider | Connects a model ID, protocol, endpoint, and credentials | That the endpoint supports every declared capability |
| Agent | Loops over messages, tools, and results inside a session | The acceptance criteria for your task |
| Tool | Reads, searches, executes, edits, or delegates work | That every call is safe or approved |
| workspace | Provides the task's filesystem context | A complete sandbox or data boundary |
| session | Stores conversation, events, and recoverable state | A simple chat transcript |
| profile | Determines which runtime compositions are loaded | The task text or the model itself |
| bundle | Adds capabilities and defaults to the plugin tree | A stable public API forever |

## When is it useful?

dsh is useful when a task needs an **observe → act → verify** loop, for example:

- locating a test failure and making a small repository change;
- reading several modules and producing an architecture note with file evidence;
- running bounded maintenance tasks in disposable workspaces;
- preserving sessions, events, and workspace state from Python;
- changing tools, models, permissions, or UI behavior through plugin compositions.

For a single simple question, a model API or chat page is usually simpler. A harness
earns its complexity through orchestration and boundary control, not by wrapping an
ordinary question in a command.

## What Developer Preview means

Developer Preview does not mean “unusable”. It means that today's configuration must
not be treated as a permanent interface. Record the following when you use dsh:

- the dsh npm version or source commit;
- Node and Python versions;
- the profile, bundles, and patches;
- Provider ID, model ID, and protocol;
- the task template and independent acceptance commands.

Before upgrading, rerun a low-risk task in a disposable checkout and confirm startup,
credentials, model selection, tools, and exit codes.

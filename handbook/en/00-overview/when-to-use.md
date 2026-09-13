# Choosing Web, CLI, SDK, or plugins

| Your goal | Preferred entry | Why |
| --- | --- | --- |
| Explore a repository with a person in the loop | Web UI | You can see the workspace, approvals, and session state |
| Submit one task and capture an exit code | Headless CLI | Works well in scripts and simple pipelines |
| Manage repeated runs from Python | Python SDK | You control cwd, sessions, results, and logs |
| Standardize a team's runtime | Custom profile/bundle | Fixes a composition of tools, Providers, and permissions |
| Add a model, tool, or UI capability | Plugin | Uses an extension seam instead of changing the core loop |
| Ask one fact without tools | Ordinary model API | Smaller runtime surface and simpler configuration |

## Web UI: a human-controlled loop

The Web UI is valuable because it keeps a person at the task boundary:

- confirm the workspace before work starts;
- choose a Provider and model in settings;
- pause for approval before high-impact tool actions;
- inspect session history and current work together;
- pause a failed task instead of letting a pipeline continue automatically.

Use it for a first run, for observing agent behavior, or when the scope may change as
you learn about the repository.

## Headless: a deterministic entrance

Headless is a good fit when the task text is fixed, the workspace can be created by a
script, acceptance commands are explicit, and failure can block a pipeline through an
exit code. Do not turn untrusted Issue text directly into a write-enabled instruction;
handle scope, permissions, and prompt-injection risk first.

## Python SDK: program control

Use the SDK when you need to store session IDs in a task database, map events and
exceptions to business states, create isolated workspaces, control retries/timeouts,
or make dsh one stage of a larger process. The SDK does not solve isolation or
acceptance automatically.

## Plugins: changing system capabilities

Use a task or system prompt for extra instructions. Consider a plugin when you need a
new tool, model adapter, event policy, storage backend, or UI node. Plugin composition
is replaceable and unloadable, but it requires understanding profiles, bundles, Cordis
context, events, and lifecycle.

## When not to use dsh

Do not hand an agent a production directory without a recoverable copy, an irreversible
operation that cannot be reviewed, a large unclassified secret set, a task whose
acceptance is only “looks reasonable”, or a task with unfixed model/Provider/plugin
versions. Use a normal script, static analyzer, and human approval when those are the
better boundary.

# The five-layer model: making dsh controllable

People often start by memorizing commands, model names, and tool names. What makes an
agent task controllable is whether five layers line up: is the task clear, are the
boundaries locked, are the capabilities really loaded, is the state explainable, and
can the orchestration recover?

This is a reading and operating framework, not a new dsh API.

## The five layers

| Layer | Question | dsh objects to inspect |
| --- | --- | --- |
| Instruction | What must this task deliver? | Goal, scope, invariants, acceptance, stop conditions |
| Constraint | Where may the agent read, write, execute, or connect? | workspace, cwd, permissions, approvals, sandbox, network, credentials |
| Capability | Which model, tools, and extensions are actually available? | Provider, model, tool schema, profile, bundle, plugin |
| Memory | What context is saved, replayed, or carried forward? | session, events, history, persistent shell, logs, fork |
| Orchestration | Who decides the next step, and how does failure stop or continue? | turn, step, plan, sub-agent, Web/CLI/SDK lifecycle |

These layers are not independent switches. The actual action space is their
intersection: a powerful model cannot write without an editing tool; a loaded tool
cannot write to a read-only workspace; a task saying “done” is not proof without an
external acceptance check.

## 1. Instruction: turn “make it good” into a task contract

The instruction layer lets the agent decide when to continue and when to stop. A
minimum contract should state:

```text
Goal: what must be delivered
Scope: which locations may be read or changed
Invariants: which behavior, interfaces, and files must not change
Permissions: which tools, commands, network, and credentials are allowed
Acceptance: which external checks prove completion
Stop: when the agent must pause and ask
Delivery: which facts, results, and risks must be reported
```

“Do not change too much” is not an acceptance boundary. “Only change `src/` and its
tests, do not change dependencies, and run these tests” is.

## 2. Constraint: keep the action space recoverable

Before starting, check the workspace, cwd, profile, write/Shell/network capabilities,
approval behavior, credential references, and whether the task belongs in a temporary
directory, container, or branch.

Permissions are not wishes written in a prompt. A request not to access another
directory does not prove that the process cannot access it; inspect the profile,
sandbox, workspace, and operating-system permissions.

## 3. Capability: distinguish declared from usable

Names in a Provider or tool catalog are not success proofs. Check the Provider ID,
protocol, endpoint, credentials, model ID, input modality, loaded tool schemas, and a
low-risk real request. Declaring `image` does not prove the endpoint accepts images;
seeing `bash` in a catalog does not prove the current task has execution permission.

## 4. Memory: treat a session as state, not a chat window

A session may carry model selection, tool events, persistent shell state, error context,
and images. Reusing it preserves context, but it also preserves old state. Start a new
session when the workspace, Provider, model, permissions, goal, or trusted checkpoint
changes, or when you cannot identify the diff belonging to the recovery point.

At recovery time, record the last reliable checkpoint, workspace, session, model,
permissions, current diff, and external checks.

## 5. Orchestration: connect observation, action, verification, and recovery

A controllable task usually follows:

```text
read baseline
  → understand without writing
  → propose scope and plan
  → obtain necessary approval
  → make the smallest change
  → run independent checks
  → inspect diff and external results
  → deliver or recover
```

Web, CLI, and SDK are different entrances to the same loop. Headless can exit
automatically, but that does not mean business acceptance passed. An SDK can return a
`final_response`, but that does not prove tests, diff, or data-flow checks passed.

## Five questions before granting access

1. What may the agent read and change?
2. Which actual Provider, model, and tools are loaded?
3. Which state will be saved in sessions or logs?
4. Which action needs approval, and which action must stop?
5. Which external check proves completion?

If one answer is missing, do not expand permissions yet.

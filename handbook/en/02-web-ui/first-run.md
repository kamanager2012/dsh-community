# First Web UI task: from zero to a checked result

## Goal

The first run is not intended to complete complex development. It verifies four links:

```text
service reachable
  → model usable
  → workspace correct
  → read-only task can be checked
```

Stop independently at every step.

## 1. Start the service

```bash
npx @deepseek-ai/dsh web
```

Record the local address printed by the terminal. To check the port from another
terminal, check only the local address:

```bash
curl -I http://127.0.0.1:3080
```

If the port is occupied, use a port option supported by the installed version and open
the new address.

## 2. Configure a model

Open **Settings → Models** and configure one simple Provider first. Do not add several
custom endpoints at once; otherwise it becomes hard to know which route failed.

Check the Provider ID, real model ID, credential reference, endpoint reachability, and
input modality. Do not print a key to confirm a configuration. For
`MISSING_CREDENTIAL`, check the reference and environment variable name. For
`UNKNOWN_MODEL`, check the saved Provider and model ID.

## 3. Prepare a workspace

Select a clean checkout or disposable copy. Before submitting work, save a baseline:

```bash
git status --short
git diff --stat
```

If uncommitted changes exist, record their owner. A read-only task should not change
the baseline; a writing task should use a temporary branch or copy.

## 4. Send the first task

Start with a read-only request:

```text
Goal: summarize the main directories, key packages, and test entry points.
Scope: read only the selected workspace.
Do not: create, modify, or delete files; install dependencies; use the network; or access paths outside the workspace.
Evidence: cite files behind important conclusions and separate observations, inferences, and uncertainty.
Stop: ask before writing, installing, using the network, or increasing permissions.
```

This is a boundary template, not a special dsh syntax.

## 5. Check agent behavior

Do not read only the final answer. Check the displayed workspace, tool calls, approval
requests, cited paths, command output, and the final diff:

```bash
git status --short
git diff --check
```

If a read-only task creates an unexpected diff, preserve it and identify which action
created it before cleaning anything up.

## What counts as a successful first run?

- the service is reachable;
- a Provider and model can be selected;
- the correct workspace is selected;
- the task completes or stops explicitly;
- no unexpected secret is exposed;
- the workspace state matches the task contract.

This does not prove long-task recovery, plugin compatibility, or code-editing quality.
Those are separate questions.

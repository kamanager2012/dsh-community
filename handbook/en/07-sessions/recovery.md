# Session recovery and cleanup

## Checkpoint before recovery

~~~text
session ID:
parent ID:
workspace:
cwd:
Provider/model:
profile:
permissions:
last complete turn:
current diff:
last passing test:
unfinished tools:
log location:
~~~

If the workspace, permissions, or last completed boundary is unknown, do not click
continue immediately.

## Handle failures by type

### The browser closed

Open the page again and confirm the session, workspace, and running state. If only the
history text remains, treat it as “history readable, runtime unconfirmed.”

### The dsh process exited

First inspect the process exit reason and workspace. Then decide whether to restart the
service, recover the session, or create a new one. Do not let the restarted default
workspace replace the original workspace.

### The model request failed

Save the error and current session. After fixing credentials or the endpoint, decide
whether to retry based on the task's impact. A session that contains images or external
inputs may be better replaced with a new one.

### A tool or background task is stuck

Inspect tool and process status. Confirm that no background process is still writing
before restarting or cleaning up. “The page has not moved” does not prove that the
process has stopped.

### The workspace has an unexpected diff

Pause, save the diff, and identify the first write action. Do not let the Agent run a
formatter or cleanup command that hides the scene.

## When to fork

Forking is useful when you want to preserve a completed parent task while trying a
different implementation or analysis path. It is not a substitute for:

- repairing a contaminated context;
- hiding a failure;
- making a backup;
- combining different projects in one session.

For a contaminated session, create a new one and state which confirmed facts you will
copy.

## Cleanup order

~~~text
stop the task and background processes
  → save required delivery material and redacted logs
  → inspect the workspace diff
  → deliver or roll back
  → delete the temporary workspace
  → clean up the session and credential reference
  → confirm that no process or port remains
~~~

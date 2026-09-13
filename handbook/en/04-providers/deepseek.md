# The official DeepSeek Provider

## Configure it in the Web UI

1. Start the Web UI.
2. Open **Settings → Models**.
3. Enter the API key in the DeepSeek card.
4. Save it.
5. Select the model for a new session.
6. Run a low-risk read-only task as the smallest check.

The credential field is write-only in the UI. After saving, the page receives only a
redacted descriptor; the secret is stored in the credential file under `DSH_HOME`,
while settings keep a credential reference.

## Environment variables

Automation or source examples may use environment variables. Follow the variable names
for the current version and entry point. Common forms include:

```bash
export DEEPSEEK_API_KEY
# Set this only when using a compatible gateway.
# export DEEPSEEK_BASE_URL
```

Never put a real value in a script, CI output, Markdown file, or commit.

## Smallest verification task

```text
Goal: confirm that the current Provider and model can complete a low-risk read-only request.
Scope: read only the README and directory listing of a temporary workspace.
Do not: write files, install dependencies, or expand network access.
Output: list files read, observed facts, and uncertainties.
Stop: stop when credentials, model, or permissions are unclear.
```

This checks the request path. It does not prove complex tools, long context, or code
editing are compatible.

## Endpoint differences

When using a DeepSeek-compatible gateway, record its endpoint, API protocol, model ID,
streaming support, tool-call support, image support, authentication headers, and the
organization's retention and audit policy.

“It returns text” does not prove that the tool-call and context protocols required by a
code agent are compatible.

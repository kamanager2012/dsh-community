# Provider troubleshooting

## MISSING_CREDENTIAL

Check these in order:

1. Is the current Provider saved?
2. Does the UI contain a credential reference?
3. Is the environment variable name spelled consistently?
4. Can the dsh process see that variable?
5. Is `DSH_HOME` the same directory that contains the configured credential?
6. Can the current user read the credential file?

Do not write the key into a task or log to verify it.

## UNKNOWN_MODEL

Check:

- the Provider ID;
- whether the model has been saved;
- the model ID's case, prefix, and suffix;
- whether the current session still refers to a Provider that was removed;
- whether a custom endpoint rewrites the model ID;
- whether the model selector requires a new session.

## 401, 403, and 404

| Status | Common layer | Check |
| --- | --- | --- |
| 401 | Credential or authentication header | key, OAuth, AWS/ADC, and credential reference |
| 403 | Account, region, permission, or policy | organization permission, region, and gateway rules |
| 404 | Endpoint path or model | Base URL, `/v1`, model ID, and routing |
| 429 | Rate limit or budget | retry policy, concurrency, and account limits |
| 5xx | Provider, gateway, or model service | service status, timeout, and request size |

An HTTP status alone cannot prove which layer is wrong. Preserve the request stage,
a redacted endpoint identifier, and a response summary.

## Failed to fetch available models

A custom Provider usually needs its endpoint to support `GET /models` to query a model
list. If it does not provide that endpoint, enter the model manually. Do not weaken
network or credential permissions just to make a catalog query work.

## A session after changing the endpoint

After changing the Provider, model, or protocol, a new session is usually safer. An old
session may retain an old model, old image inputs, old system context, or a persistent
shell. Before continuing, confirm its history and data boundary.

## Minimum troubleshooting report

~~~text
dsh version:
Node/Python version:
Provider ID:
API protocol:
Base URL (redacted):
Model ID:
Failure stage:
HTTP status:
Exit code:
Does a new session still fail:
Were any files changed:
~~~

This is more useful and safer than reporting “the request failed” together with a key.

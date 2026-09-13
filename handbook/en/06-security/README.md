# Security

dsh security is not a single switch. It is the boundary formed by permissions,
sandboxing, workspace selection, Providers, tools, logs, and human approval.

## Four questions to keep separate

1. What is the agent allowed to request?
2. What can the process actually access?
3. What will the Provider and external tools receive?
4. How will the result be accepted externally?

An answer of “allowed” to one question does not make the other three safe.

## Default principles

- Start with least privilege.
- Start with a read-only workspace.
- Start with a temporary or recoverable copy.
- Start with a new session.
- Write stop conditions before approving high-impact actions.
- Preserve a redacted scene before cleaning up or rolling back.
- Never replace human acceptance with the agent's final answer.

The Chinese edition contains the detailed chapters on permissions, credentials, data
flow, threat modeling, and incident response. The English translations will follow the
same paths under `en/06-security/` and retain the Chinese pages as their source.

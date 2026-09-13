# Frequently asked questions

## Why can dsh start but fail to send a task?

The Web UI needs a selected workspace first; without one, the input may be unavailable.
If a workspace is selected, check the Provider, model, and credential.

## Does a visible web page prove that the model is available?

No. An accessible page proves only that the service and route are reachable. A model
request still depends on the Provider, credential, model ID, network, and endpoint.

## Why did the old session not change after I changed the default model?

A session that has already sent requests usually keeps its own model record. Use a new
session to verify the new default model instead of mixing it with old history.

## What should I do about MISSING_CREDENTIAL?

Check the Provider credential reference, environment variable name, process environment,
and `DSH_HOME`. Do not print the key. See [Provider troubleshooting](../04-providers/troubleshooting.md).

## Why did fetching the model list fail?

A custom endpoint may not provide `GET /models`, or the key, Base URL, or authentication
may be wrong. Enter the model ID manually and verify the actual request.

## Why is an image model still rejecting image input?

A manually entered model needs to declare its input capability; that declaration is only
a capability assertion. The endpoint may still not support it. After fixing the setup,
use a new session so old image inputs are not resent.

## Why did the task say it was complete without producing a diff?

The task may have been read-only, the permission may have been read-only, the edit tool
may have failed, the path may have been outside the workspace, or the Agent may have
produced only a plan. Check tool results and the actual diff.

## Why is a passing test command not enough to publish?

A passing command proves only that command. Also inspect the complete diff, dependencies,
data flow, version, documentation, license, deployment, and human acceptance.

## Can I use the highest permission mode directly?

It is not recommended. Narrow the workspace, task, tools, and acceptance first. Use high
privilege only in an isolated and disposable environment.

## Why create a new session?

An old session may retain a model, images, persistent shells, incorrect context, and tool
events. When the goal, Provider, workspace, or permissions change, a new session is easier
to explain.

## Can I use dsh as an ordinary chat API?

It can issue model requests, but dsh's main value is the combination of Agent, tools,
sessions, permissions, and composition. For question answering alone, an ordinary API
may be simpler.

## Can I expose the dsh Web UI to the public internet?

Do not expose it directly. For remote use, design authentication, TLS, network controls,
workspace isolation, logs, and a shutdown path first.

## What is the relationship between a Skill and this handbook?

The Markdown handbook is for people; a Skill is a set of automatic execution rules for an
Agent. Maintain the handbook first, then derive a Skill from stable workflows. Do not turn
unstable experiment records into Skill behavior.

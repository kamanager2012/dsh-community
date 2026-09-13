# English edition status

This is the maintained English edition of the [DeepSeek Harness Chinese Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/).
It prioritizes the chapters that contain operating judgment rather than translating every
reference page in filename order. The current path covers core concepts, installation,
the first Web UI task, CLI, DeepSeek Provider setup and troubleshooting, the main delivery
workflow, review and acceptance, Session recovery, security principles, FAQ, and glossary.
It also includes the English community ecosystem map and the Community Labs handoff so
that repository boundaries and experimental status are documented in both languages.

The Chinese Markdown under `content/` remains the primary factual source. English pages
are maintained translations and preserve commands, configuration names, identifiers,
version warnings, and source links. The remaining specialist chapters will be added under
the same directory layout instead of being silently replaced with machine-generated text.
Page count is intentionally not the quality target; high-value troubleshooting and workflow
coverage comes first.

## Translation rules

- Commands, paths, environment variables, configuration keys, API names, and identifiers are not translated.
- `Provider`, `Session`, `workspace`, `profile`, `bundle`, `patch`, `Cordis`, and `MCP` keep their technical spelling and are explained in plain English.
- The English edition does not invent runtime results, screenshots, benchmarks, or compatibility claims.
- When a version or capability may change, follow current upstream documentation and `--help` output.

Use the [English handbook home](index.md) to read the available path. The complete Chinese
edition is available on the [online handbook](https://kamanager2012.github.io/deepseek-harness-handbook/).

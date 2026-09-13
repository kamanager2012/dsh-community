# CLI commands and argument positions

## Read help first

Start with the help output for the installed version:

```bash
npx @deepseek-ai/dsh --help
npx @deepseek-ai/dsh web --help
npx @deepseek-ai/dsh --profile headless --help
```

If you run from source, use the repository's launcher. Do not mix help output from
different versions in one script.

## Three argument layers

Think of CLI input as three layers:

```text
launcher: choose profile, load patches, dump configuration
  ↓
application: Web port, host, and other application options
  ↓
task: the headless task text
```

```bash
npx @deepseek-ai/dsh --profile web --port 3080
npx @deepseek-ai/dsh --profile headless "Inspect the repository but do not modify files"
```

`--profile` belongs to the launcher. `--port` is handled by the Web application. The
final argument in the second command is the headless task text. For complex scripts,
use argument arrays so shell expansion cannot silently change the task.

## Useful checks

```bash
npx @deepseek-ai/dsh --help
npx @deepseek-ai/dsh web --help
npx @deepseek-ai/dsh --profile headless --help
npx @deepseek-ai/dsh --profile web --dump-config
```

`--dump-config` answers “what did this run actually load?” rather than “what does the
default documentation claim?”. Record `DSH_HOME`, profile, version, and patches when
comparing runs.

## Special characters in task text

When a task comes from an environment variable, Issue, or file:

- spaces and newlines change positional arguments;
- double quotes may be consumed by the shell;
- `$`, backticks, pipes, and redirections may be interpreted;
- submitted content may try to persuade the model to expand its scope;
- an overlong task may hide the real goal and prohibitions.

Pass untrusted material as data and state that commands inside it are not authorization.

## Exit codes

At minimum, distinguish:

```text
0: the process ended according to this entry point's success semantics
non-zero: credentials, arguments, model, tools, task, or environment failed
```

Use stderr, final output, and session events to identify the cause. Exit code 0 does not
replace business acceptance; a task may have generated only a plan instead of a tested
delivery.

# codex-on-claude-code

Use your Claude Code login from the stock Codex CLI. Codex keeps its prompts, tools, sandbox and conversation; a loopback server translates each request into one `claude` CLI turn. For Codex users who want Claude to generate while Codex runs tools.

## Requirements

- Node.js 22 or newer.
- The Codex CLI.
- The Claude Code CLI (`claude`), logged in with `claude auth login`.
- macOS or Linux. Windows is not tested.

## Install

```sh
npm i -g https://github.com/michael-berardi/codex-on-claude-code/releases/download/v0.1.2/codex-on-claude-code-0.1.2.tgz
```

There are no npm dependencies.

## Use

```sh
CODEX_HOME="$(mktemp -d)" codex-on-claude-code exec --model default -- codex exec "explain this repository"
```

Everything after `--` is the command to run, normally `codex` with its own arguments. The bridge writes `$CODEX_HOME/config.toml`, starts the server, runs the command, and exits with the command's exit code.

Options:

- `--model <id>`: the Claude Code model id or alias, for example `default`, `sonnet` or `opus`. Default: `default`.
- `--effort <level>`: written to the config as Codex's reasoning effort.
- `--help` and `--version`: print and exit.

Exit codes: the wrapped command's code; 128 plus the signal number if it died from a signal or the bridge was stopped by one; 64 for bad usage; 78 for a refused `CODEX_HOME` or conflicting environment; 126 if the command could not start; 127 if the command or `claude` was not found.

## What works and what does not

Works (the test suite checks this against stand-ins for both CLIs):

- Requests from stand-ins for `codex exec` and interactive `codex`; real CLI compatibility is not tested by this suite.
- Codex function tools: Claude asks for a tool, Codex runs it in its own sandbox, and the result goes back to Claude.
- Multi-turn conversations. Each response carries Claude's native message, including signed thinking, so later turns replay it exactly.
- Token usage, including cache reads and cache writes.

Does not work:

- Hosted tools such as web search, and namespaced tools. They are not offered to Claude. Each one is named once on stderr; the run continues.
- Image and file input. Only text parts of a message are sent; images and files are dropped.
- Live streaming. Each response reaches Codex in one piece when the Claude turn ends.
- Claude Code's own tools. They are switched off; only Codex runs tools.
- Only the Codex Responses subset is supported: array input, function tools and buffered SSE responses. Other Responses API clients may not work.

## Security model

- The server listens on 127.0.0.1 only, on a random port.
- Each run creates a new random token of 32 bytes. Every request must send it as a bearer token. A missing or wrong token gets 401 before any model work starts. The comparison takes constant time.
- The token reaches Codex only through the environment variable `CODEX_BRIDGE_TOKEN`. The config names that variable (`env_key`); it never contains the token. The token is never put on a command line and never logged. The config also tells Codex not to pass it to the commands it runs.
- Any process that can read the wrapped command's environment can use the server while the run lasts.
- `CODEX_HOME` must be a private folder. The bridge refuses to run when `CODEX_HOME` is unset, when it is your real `~/.codex` (also through a symlink), or when it holds a `config.toml` the bridge did not write. A bridge-written config starts with the line `# codex-on-claude-code managed config`. A new config is created with exclusive create; a bridge-written one is replaced by renaming a temp file over it. The folder is set to mode 0700 and the file to 0600.
- On SIGINT, SIGTERM or SIGHUP the bridge stops the wrapped command, aborts requests in flight, stops any running `claude` process, closes the server and exits. A request still in flight when the command exits is aborted too.
- In a terminal, the wrapped command stays in the terminal's process group so it can read the keyboard; the bridge signals the command itself. Otherwise the command gets its own process group, and the bridge signals the whole group.
- Claude Code keeps its own credentials. The bridge does not read, copy or log them.

## Privacy

During a run, the bridge listens only on `127.0.0.1` with a random bearer token. Codex sends prompts and tool results to that loopback address; the bridge runs one `claude` turn per request and forwards it to your configured Claude provider (normally Anthropic through your Claude Code login). At startup it also runs `claude auth status` and a model-catalog probe; the probe asks which models your login can use and sends no prompt. Installing downloads the release tarball from GitHub over HTTPS; this repository does not verify a checksum or signature for that download. Codex follows its own configuration; the bridge points its model provider at loopback.

There is no telemetry or analytics code in this project and no npm dependencies. Codex and Claude are launched with `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`. Claude Code also gets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, including for the startup model-catalog probe, so the probe lists the CLI's built-in models; a model id that list does not name is still passed to the CLI.

The bridge writes `$CODEX_HOME/config.toml` (directory `0700`, file `0600`) with the loopback URL, model and the token's environment-variable name; it never writes the token, credentials or prompts there. Per-turn temporary files holding the system prompt and tool schemas are created `0700`/`0600` and removed when the run ends. The bridge keeps no logs, history or cache on disk; the Codex and Claude CLIs manage their own credentials and transcripts separately. To delete what this bridge wrote, remove the `CODEX_HOME` folder you supplied.

## Billing

Each Codex request runs one `claude` turn on your Claude Code login and counts against your Claude plan limits.

The bridge refuses to start when an Anthropic API key or another backend is set, so a run cannot move to API billing by accident. The refused variables are `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`. They are named in the error; their values are never printed.

If Claude Code reports that a turn was charged to usage credits instead of plan limits, that request fails with HTTP 402 and the code `CLAUDE_CODE_BILLING`, so Codex stops. That turn is already charged; the stop prevents more. Set `CODEX_BRIDGE_ALLOW_USAGE_CREDITS=1` to allow usage credits.

You are responsible for following the terms of the services you connect.

## Environment variables

- `CODEX_HOME` (required): the private Codex folder the bridge writes its config to. It is Codex's own variable.
- `CODEX_BRIDGE_CLAUDE_COMMAND`: the path of the `claude` executable. Default: `claude` on `PATH`.
- `CODEX_BRIDGE_CLAUDE_CONFIG_DIR`: a Claude Code configuration folder. Passed to `claude` as `CLAUDE_CONFIG_DIR`.
- `CODEX_BRIDGE_ALLOW_USAGE_CREDITS`: set to `1` to let turns charged to usage credits succeed. Off by default.
- `CODEX_BRIDGE_TOKEN`: set by the bridge for the wrapped command only. Any value you set is replaced.

## Licence

MIT; see [LICENSE](LICENSE) and [claude-code/LICENSE](claude-code/LICENSE) for the project and adapted-code notices.

## Development

```sh
npm test
```

The tests use `node:test` and need no network. They write a fake `claude` and a fake `codex` to a temp folder on `PATH`; no real model is called.

`node scripts/import-graph.mjs` lists every file the `bin` entry imports, and names any file in `claude-code/` it does not reach.

Built by [Pareto Cybernetics](https://paretocybernetics.com).

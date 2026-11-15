# Changelog

## 0.1.1

- Return HTTP 400 for malformed request objects and array entries without starting a model turn.
- Keep developer messages after an initial assistant turn in conversation order.
- Shorten installation instructions and clarify the tested Responses API subset.

## 0.1.0

First release.

- Loopback Responses server on 127.0.0.1 with a per-run bearer token, passed to Codex through `CODEX_BRIDGE_TOKEN`.
- Each Codex request runs one `claude` CLI turn on your Claude Code login.
- Function tools, tool results, replay of Claude's native messages, and token usage are translated.
- Refuses an unset or shared `CODEX_HOME`, a foreign `config.toml`, a missing `claude` or command, and conflicting API-key or backend variables.
- Stops turns charged to usage credits unless `CODEX_BRIDGE_ALLOW_USAGE_CREDITS=1` is set.
- Passes the wrapped command's exit code through, and shuts down cleanly on SIGINT, SIGTERM and SIGHUP.

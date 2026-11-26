# Changelog

## 0.2.0

- Update notice: after a command run in a terminal, two lines on stderr when a newer stable release exists, at most once a day per version. Based on one anonymous, cached check of the GitHub latest-release record a day; silent in pipes, CI, under Claude Code and for JSON output.
- `update` installs the release tarball with npm only after its SHA-256 matches the release's `SHA256SUMS`. Also `update --check` (exit 0, 10 or 1), `--skip`, `--rollback`, `--auto on|off|status` and `--checks on|off|status`.
- Automatic installs are opt-in, run detached at low priority, and log to one file of at most 256 KB.
- Opt-out: `CODEX_ON_CLAUDE_CODE_NO_UPDATE_CHECK=1` or `update --checks off`. `update --auto off` removes the update files.
- New `PRIVACY.md` and `docs/updates.md`.

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

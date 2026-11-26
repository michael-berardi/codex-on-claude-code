# Privacy

`codex-on-claude-code` has no telemetry, analytics or accounts of its own.

## The bridge

- The Responses server listens on 127.0.0.1 only. Each Codex request becomes one `claude` CLI turn on your Claude Code login, which Claude Code sends to Anthropic as it does for any turn.
- The bridge writes `CODEX_HOME/config.toml` and, for each turn, a temp folder for the `claude` process that is removed when the turn ends. It does not log prompts or replies.
- Claude Code keeps its own credentials. The bridge does not read, copy or log them.

## The update check

- One anonymous HTTPS `GET` of the public GitHub "latest release" record for the repository named in `package.json`. Headers: `Accept` and `User-Agent: codex-on-claude-code-update-check`. No id, installed version, usage, command line or machine data is sent. GitHub sees your IP address, as with any HTTPS request.
- At most once every 24 hours, and only when you run a command in a terminal. Never with `CI` set, under Claude Code, for machine-readable output, or when turned off with `CODEX_ON_CLAUDE_CODE_NO_UPDATE_CHECK=1` or `codex-on-claude-code update --checks off`.
- `update` and `update --check` request the same record when you run them. An install also downloads the release tarball and `SHA256SUMS` from the same GitHub release.

## Stored on your machine

- `update.json` in your cache folder (`$XDG_CACHE_HOME/codex-on-claude-code/`, or `~/Library/Caches/codex-on-claude-code/` on macOS, `~/.cache/codex-on-claude-code/` on Linux): last check time and result, latest version and its download URLs, your skip, check and auto choices, the last notice, and at most one rollback entry. Mode 0600, written atomically.
- `update.log` next to it, only after automatic installs, capped at 256 KB.
- Downloads go to a temp folder that is removed after the install, successful or not. The rollback entry is dropped after the new version has run once, or after seven days.
- `codex-on-claude-code update --auto off` removes both files. Run it before `npm uninstall -g codex-on-claude-code` to leave nothing behind.

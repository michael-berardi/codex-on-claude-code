<!-- update-contract: v1 -->

# Updates

## Notice

After a command you ran in a terminal, `codex-on-claude-code` writes two lines to stderr when a newer stable release exists:

```text
codex-on-claude-code 0.3.0 available (you have 0.2.0) · run: codex-on-claude-code update
turn on automatic updates: codex-on-claude-code update --auto on · skip: codex-on-claude-code update --skip
```

The notice comes after the wrapped command has ended, at most once a day for the same version. A skipped version is not shown again; a newer one is.

There is no check and no notice when stdin, stdout or stderr is not a terminal, when `CI` is set, under Claude Code (`CLAUDECODE=1`), or when the wrapped command writes machine output (`--json`, `--experimental-json`, `--output-schema`).

## How the check works

- One anonymous `GET` of `https://api.github.com/repos/<owner>/<repo>/releases/latest`, for the repository named in `package.json`. The only headers set are `Accept` and `User-Agent: codex-on-claude-code-update-check`. No id, version, usage or machine data is sent.
- At most once every 24 hours. It runs alongside the wrapped command with a 4-second timeout and never delays its start.
- Only stable `x.y.z` releases newer than yours count. Drafts, prereleases and other tags are ignored.
- A failed check is stored with its cause and not retried until the day is over. `update --check` shows it.

## Commands

- `codex-on-claude-code update`: shows the current and new version and the first lines of the release notes, then asks `Install <new> now? [Y/n]`. After a successful install it asks once `Install future updates automatically? [y/N]`; the answer is remembered. Without a terminal it installs without asking.
- `codex-on-claude-code update --check`: report only. Exit code 0 when current, 10 when an update exists, 1 when the check failed (the cause goes to stderr).
- `codex-on-claude-code update --skip`: no notice for the latest version until a newer one comes out.
- `codex-on-claude-code update --auto on|off|status`: automatic installs. Off by default. `off` also removes the cache and log files.
- `codex-on-claude-code update --checks on|off|status`: the automatic check itself. `CODEX_ON_CLAUDE_CODE_NO_UPDATE_CHECK=1` turns it off too.
- `codex-on-claude-code update --rollback`: reinstall the version that ran before the last update, and skip the one you left.

## Install safety

`update` works for the documented install, `npm i -g <release .tgz URL>`. It downloads the release's `codex-on-claude-code-<version>.tgz` and `SHA256SUMS` into a new temp folder, compares the tarball's SHA-256 with its line in `SHA256SUMS`, and only then runs `npm install --global --prefix <your npm prefix>` on that verified file. A missing or wrong checksum refuses the install and leaves your version unchanged. The temp folder is removed whether the install succeeds or fails.

A git checkout or `npm link` is never overwritten; `update` prints the `npm i -g` command to run instead.

The new version applies the next time you run `codex-on-claude-code`; a running command is not touched.

The previous version is kept as one rollback entry (its release URLs, not a copy of the files). `update --rollback` verifies and installs it the same way. The entry is dropped once the new version has run successfully, or after seven days.

## Automatic updates

With `update --auto on`, a check that finds a newer release starts a detached, low-priority install with the same checks. Its result goes to one log file of at most 256 KB. If it fails, your current version keeps working, the cause is shown by `update --auto status`, and the normal notice comes back.

## Files

One state file, `update.json`, in `$XDG_CACHE_HOME/codex-on-claude-code/` when that variable is set, otherwise `~/Library/Caches/codex-on-claude-code/` on macOS and `~/.cache/codex-on-claude-code/` on Linux. It holds the last check time and result, the latest version and its two download URLs, your skip, check and auto choices, the last notice, and the rollback entry. It is written atomically with mode 0600. `update.log`, next to it, exists only after background installs.

To remove everything: `codex-on-claude-code update --auto off`, then `npm uninstall -g codex-on-claude-code`.

## Testing against a local release

`CODEX_ON_CLAUDE_CODE_UPDATE_API` replaces the release API URL, for example with a local server that serves a fake newer release. While it is set, plain `http://` download URLs are accepted.

// Update contract v1: version gating, the anonymous daily check, silence rules, the notice, `update` and its options,
// verified install, rollback, the opt-in background install and the debris bounds. No test reaches the network: the
// release API is an injected fetch or a 127.0.0.1 server, and npm is a stub that records what it was given.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  LOG_LIMIT, VERSION, afterCommand, appendLog, checkForUpdate, checksAllowed, isNewer, logPath, noticeLines,
  parseRelease, prunePrevious, readState, releaseApi, repositorySlug, runUpdate, statePath, writeState,
} from "../codex-bridge/update.mjs";
import { main } from "../codex-bridge/bridge.mjs";
import { root as repoRoot, sandbox } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1_000;
const NAME = "codex-on-claude-code";
const tgzName = (version) => `${NAME}-${version}.tgz`;
const tarball = (version) => Buffer.from(`release tarball ${version}`);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asset = (version, name, base = "https://example.invalid/releases/download") => `${base}/v${version}/${name}`;
const sink = (isTTY = false) => ({ isTTY, text: "", write(chunk) { this.text += chunk; return true; } });
const quiet = (extra = {}) => ({ stdout: sink(), stderr: sink(), stdin: { isTTY: false }, ...extra });

/** The release API plus SHA256SUMS and tarballs under /v<version>/; `tamper` serves wrong bytes for that version. */
function releaseServer({ latest = "9.0.0", body = "Fixes a bug.\n\nSecond line.", sums = true, prerelease = false, fail, tamper, base } = {}) {
  const calls = [];
  const respond = (url) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith("/releases/latest")) {
      return Response.json({
        tag_name: `v${latest}`, draft: false, prerelease, body,
        assets: [
          { name: tgzName(latest), browser_download_url: asset(latest, tgzName(latest), base) },
          ...(sums ? [{ name: "SHA256SUMS", browser_download_url: asset(latest, "SHA256SUMS", base) }] : []),
        ],
      });
    }
    const [, version, name] = /\/v([^/]+)\/([^/]+)$/.exec(pathname) ?? [];
    if (name === "SHA256SUMS") return new Response(`${sha(tarball(version))}  ${tgzName(version)}\n`);
    if (name && name === tgzName(version)) return new Response(version === tamper ? Buffer.from("tampered") : tarball(version));
    return new Response("not found", { status: 404 });
  };
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...options.headers } });
    if (fail) throw new Error(fail);
    return respond(url);
  };
  return { fetch, calls, respond };
}

/** A private folder with HOME, cache and TMPDIR inside it, and a stub npm first on PATH. */
function box() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-update-test-")));
  const bin = join(dir, "bin"), npmLog = join(dir, "npm.log");
  for (const sub of ["bin", "home", "tmp"]) mkdirSync(join(dir, sub));
  // Records its arguments and the SHA-256 of the file it was asked to install, as it was at that moment.
  writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require("node:fs"), { createHash } = require("node:crypto");
const args = process.argv.slice(2), file = args.at(-1);
const sha = fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args, sha }) + "\\n");
process.exit(Number(process.env.FAKE_NPM_EXIT ?? 0));
`, { mode: 0o755 });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: join(dir, "home"), XDG_CACHE_HOME: join(dir, "cache"), TMPDIR: join(dir, "tmp"),
    FAKE_NPM_LOG: npmLog, NO_COLOR: "1",
  };
  const prefix = join(dir, "prefix");
  return {
    dir, env, prefix, root: join(prefix, "lib", "node_modules", NAME), cache: join(dir, "cache", NAME),
    npm: () => existsSync(npmLog) ? readFileSync(npmLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
    temps: () => readdirSync(env.TMPDIR),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
async function withBox(fn) { const b = box(); try { return await fn(b); } finally { b.cleanup(); } }

// Protects version gating: only a strictly newer stable x.y.z is an update; drafts and prereleases are not.
test("version comparison: newer, equal, older, garbage and prerelease", () => {
  assert.equal(isNewer("0.3.0", "0.2.0"), true);
  assert.equal(isNewer("v1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.10.0", "0.9.0"), true, "numeric, not lexical");
  assert.equal(isNewer("0.2.0", "0.2.0"), false);
  assert.equal(isNewer("0.1.9", "0.2.0"), false);
  for (const bad of ["0.3.0-beta.1", "nightly", "0.3", "0.3.0.1", "", null, undefined]) assert.equal(isNewer(bad, "0.2.0"), false, String(bad));
  const record = { tag_name: "v0.3.0", body: "a\nb", assets: [] };
  assert.equal(parseRelease(record).version, "0.3.0");
  for (const bad of [{ ...record, draft: true }, { ...record, prerelease: true }, { ...record, tag_name: "v0.3.0-rc.1" }, null]) {
    assert.equal(parseRelease(bad), null);
  }
});

// Protects privacy and the 24-hour cache: one GET with only Accept and the fixed User-Agent, to the repository that
// package.json declares; a failure is cached with its cause and not retried until the day is over.
test("the check is one anonymous GET, cached for 24 hours; a failure is cached with its cause", () => withBox(async (b) => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(releaseApi({}), `https://api.github.com/repos/${repositorySlug()}/releases/latest`);
  assert.ok(pkg.repository.url.includes(`github.com/${repositorySlug()}`));
  const { fetch, calls } = releaseServer();
  const first = await checkForUpdate({ env: b.env, fetch, now: 1_000 });
  assert.equal(first.state.latest, "9.0.0");
  assert.deepEqual(first.notes, ["Fixes a bug.", "Second line."]);
  assert.deepEqual(calls[0].headers, { accept: "application/vnd.github+json", "user-agent": `${NAME}-update-check` });
  assert.equal(new URL(calls[0].url).search, "");
  await checkForUpdate({ env: b.env, fetch, now: 1_000 + DAY - 1 });
  assert.equal(calls.length, 1, "no second request within 24 hours");
  await checkForUpdate({ env: b.env, fetch, now: 1_000 + DAY });
  assert.equal(calls.length, 2);

  const offline = releaseServer({ fail: "getaddrinfo ENOTFOUND api.github.com" });
  const failed = await checkForUpdate({ env: b.env, fetch: offline.fetch, now: 3 * DAY });
  assert.match(failed.state.error, /ENOTFOUND/);
  assert.match(readState(b.env).error, /ENOTFOUND/, "the cause is in the cache");
  await checkForUpdate({ env: b.env, fetch: offline.fetch, now: 3 * DAY + 60_000 });
  assert.equal(offline.calls.length, 1, "a failure is not retried in a loop");

  // §8: one small private file, written atomically (no temp file left), nothing else in the folder.
  assert.deepEqual(readdirSync(b.cache), ["update.json"]);
  assert.equal(statSync(statePath(b.env)).mode & 0o777, 0o600);
  assert.equal(statSync(b.cache).mode & 0o777, 0o700);
  assert.ok(statSync(statePath(b.env)).size < 1_024);
}));

// Protects the silence rules: no automatic check off a terminal, in CI, under an agent, for machine output, or
// after either opt-out.
test("automatic checks are off without a terminal, in CI, for agents, for JSON output and after opt-out", () => withBox(async (b) => {
  const tty = { isTTY: true }, pipe = { isTTY: false };
  const allowed = (over = {}) => checksAllowed({ args: [], env: b.env, stdout: tty, stderr: tty, stdin: tty, ...over });
  assert.equal(allowed(), true, "on by default for a person at a terminal");
  assert.equal(allowed({ stdout: pipe }), false);
  assert.equal(allowed({ stderr: pipe }), false);
  assert.equal(allowed({ stdin: pipe }), false);
  assert.equal(allowed({ env: { ...b.env, CI: "" } }), false);
  assert.equal(allowed({ env: { ...b.env, CODEX_ON_CLAUDE_CODE_NO_UPDATE_CHECK: "1" } }), false);
  assert.equal(allowed({ env: { ...b.env, CLAUDECODE: "1" } }), false);
  for (const flag of ["--json", "--experimental-json", "--output-schema=schema.json"]) assert.equal(allowed({ args: ["exec", flag, "task"] }), false, flag);
  assert.equal(await runUpdate({ action: "checks", value: "off" }, { env: b.env, ...quiet() }), 0);
  assert.equal(allowed(), false, "the stored switch");
  const status = quiet();
  await runUpdate({ action: "checks", value: "status" }, { env: b.env, ...status });
  assert.equal(status.stdout.text, "automatic update checks: off\n");
}));

// Protects the notice: exact two lines on stderr, once a day per version, never for a skipped version, again for a
// newer one, and nothing when current.
test("the notice is two stderr lines, at most daily per version, never for a skipped version", () => withBox(async (b) => {
  const notice = (now, env = b.env) => { const stderr = sink(true); return afterCommand(undefined, { env, stderr, current: "0.2.0", now }).then(() => stderr.text); };
  writeState(b.env, { ...readState(b.env), latest: "0.3.0" });
  assert.equal(await notice(1_000), [
    "codex-on-claude-code 0.3.0 available (you have 0.2.0) · run: codex-on-claude-code update",
    "turn on automatic updates: codex-on-claude-code update --auto on · skip: codex-on-claude-code update --skip", "",
  ].join("\n"));
  assert.equal(await notice(1_000 + DAY - 1), "", "not again the same day");
  assert.match(await notice(1_000 + DAY), /0\.3\.0 available/);
  assert.match((await notice(5 * DAY, { ...b.env, NO_COLOR: undefined })).split("\n")[1], /^\u001b\[2mturn on automatic updates: .*\u001b\[0m$/, "second line dim");
  writeState(b.env, { ...readState(b.env), skipped: "0.3.0" });
  assert.equal(await notice(10 * DAY), "", "skipped");
  writeState(b.env, { ...readState(b.env), latest: "0.4.0" });
  assert.match(await notice(10 * DAY), /0\.4\.0 available/, "a newer release notifies again");
  writeState(b.env, { ...readState(b.env), latest: "0.2.0" });
  assert.equal(await notice(20 * DAY), "", "current");
  assert.deepEqual(noticeLines("0.2.0", "0.3.0").length, 2);
}));

// Protects placement and the startup path through the real `exec`: the notice comes after the command, on stderr
// only; machine output, pipes and CI make no request and write no file; a hanging API is cut off at 4 s and cached.
test("exec: notice after the command on stderr; JSON output, pipes and CI make no request", { timeout: 120_000 }, async () => {
  const box = sandbox();
  try {
    const env = { ...box.env, XDG_CACHE_HOME: join(box.dir, "cache"), NO_COLOR: "1" };
    const cacheFile = statePath(env);
    const exec = async (args, { tty = true, extraEnv = {}, fetch } = {}) => {
      const stdout = sink(tty), stderr = sink(tty);
      const status = await main(["exec", "--", "true", ...args], { env: { ...env, ...extraEnv }, stdout, stderr, stdin: { isTTY: tty }, fetch });
      return { status, out: stdout.text, err: stderr.text };
    };
    const quietRelease = releaseServer({ latest: "9.0.0" });
    for (const [args, opts] of [[["--json"], {}], [[], { tty: false }], [[], { extraEnv: { CI: "1" } }]]) {
      const result = await exec(args, { ...opts, fetch: quietRelease.fetch });
      assert.deepEqual(result, { status: 0, out: "", err: "" });
    }
    assert.equal(quietRelease.calls.length, 0, "no request");
    assert.equal(existsSync(cacheFile), false, "no file");

    writeState(env, { ...readState(env), previous: { version: "0.1.1", tgzUrl: "https://x/a.tgz", sumsUrl: "https://x/SHA256SUMS", installed: VERSION, at: Date.now() } });
    const { fetch, calls } = releaseServer({ latest: "9.0.0" });
    const shown = await exec([], { fetch });
    assert.equal(shown.status, 0);
    assert.equal(shown.out, "", "nothing on stdout");
    assert.equal(shown.err, `${noticeLines(VERSION, "9.0.0").join("\n")}\n`);
    assert.equal(calls.length, 1);
    assert.equal(readState(env).previous, null, "the rollback entry goes after the new version ran once");
    assert.equal((await exec([], { fetch })).err, "", "cached, and shown once a day");
    assert.equal(calls.length, 1);

    writeState(env, { ...readState(env), lastCheck: 0, latest: null, shownVersion: null });
    const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const started = Date.now();
    const slow = await exec([], { fetch: hang });
    assert.ok(Date.now() - started < 8_000, "bounded by the 4 s timeout");
    assert.equal(slow.err, "", "a failed check prints nothing");
    assert.match(readState(env).error, /timeout/i);
  } finally { box.cleanup(); }
});

// Protects the report-only command and the stored choices: exit codes 0/10/1, --skip, --auto persistence, and
// `--auto off` removing every file the updater wrote.
test("update --check exits 0, 10 or 1 with the cause; --skip and --auto persist; --auto off removes the files", () => withBox(async (b) => {
  const cli = async (args, fetch) => {
    const io = quiet();
    const status = await main(["update", ...args], { env: b.env, ...io, fetch });
    return { status, out: io.stdout.text, err: io.stderr.text };
  };
  const newer = releaseServer({ latest: "9.0.0" });
  const available = await cli(["--check"], newer.fetch);
  assert.equal(available.status, 10);
  assert.equal(available.out, `${NAME} 9.0.0 available (you have ${VERSION}) · run: ${NAME} update\n  Fixes a bug.\n  Second line.\n`);
  assert.deepEqual(b.npm(), [], "--check never installs");
  assert.deepEqual(await cli(["--check"], releaseServer({ latest: VERSION }).fetch), { status: 0, out: `${NAME} ${VERSION} is up to date\n`, err: "" });
  assert.deepEqual(await cli(["--check"], releaseServer({ latest: "9.0.0", prerelease: true }).fetch), { status: 0, out: `${NAME} ${VERSION} is up to date\n`, err: "" });
  const failed = await cli(["--check"], releaseServer({ fail: "connect ECONNREFUSED" }).fetch);
  assert.equal(failed.status, 1);
  assert.equal(failed.out, "");
  assert.equal(failed.err, `${NAME}: update check failed: connect ECONNREFUSED\n`);

  assert.equal((await cli(["--check"], newer.fetch)).status, 10);
  assert.deepEqual(await cli(["--skip"], releaseServer({ fail: "offline" }).fetch), { status: 0, out: "skipped 9.0.0; a newer release will be announced again\n", err: "" }, "--skip uses the cached release");
  assert.equal(readState(b.env).skipped, "9.0.0");

  assert.equal((await cli(["--auto", "status"])).out, "automatic updates: off\n", "off by default");
  assert.equal((await cli(["--auto", "on"])).out, "automatic updates: on\n");
  assert.equal(readState(b.env).auto, true);
  assert.equal((await cli(["--auto", "status"])).out, "automatic updates: on\n");
  appendLog(b.env, "installed 9.0.0");
  assert.deepEqual(readdirSync(b.cache).sort(), ["update.json", "update.log"]);
  assert.deepEqual(await cli(["--auto", "off"]), { status: 0, out: "automatic updates: off (update cache and log removed)\n", err: "" });
  assert.equal(existsSync(b.cache), false, "--auto off leaves no cache, state or log");
  assert.equal(readState(b.env).auto, false);
}));

// Protects install safety: the tarball is checked against SHA256SUMS before npm runs; any mismatch, missing sums or
// failed download refuses, leaves no temp folder, and a non-npm copy is never overwritten.
test("update refuses a checksum mismatch, missing SHA256SUMS and a non-npm copy; no temp folder is left", () => withBox(async (b) => {
  const update = async (server, root = b.root) => {
    const io = quiet();
    const status = await runUpdate({ action: "install" }, { env: b.env, ...io, fetch: server.fetch, root });
    return { status, err: io.stderr.text };
  };
  const mismatch = await update(releaseServer({ tamper: "9.0.0" }));
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.err, /CODEX_ON_CLAUDE_CODE_UPDATE_CHECKSUM: checksum mismatch for codex-on-claude-code-9\.0\.0\.tgz; nothing was installed/);
  assert.match((await update(releaseServer({ sums: false }))).err, /has no codex-on-claude-code-9\.0\.0\.tgz or SHA256SUMS asset/);
  const noEntry = releaseServer();
  const sumsWithoutEntry = { fetch: async (url, o) => String(url).endsWith("SHA256SUMS") ? new Response(`${sha("x")}  other.tgz\n`) : noEntry.fetch(url, o) };
  assert.match((await update(sumsWithoutEntry)).err, /SHA256SUMS has no entry for codex-on-claude-code-9\.0\.0\.tgz/);
  const missing = releaseServer();
  const gone = { fetch: async (url, o) => String(url).endsWith(".tgz") ? new Response("", { status: 404 }) : missing.fetch(url, o) };
  assert.match((await update(gone)).err, /codex-on-claude-code-9\.0\.0\.tgz returned HTTP 404/);
  assert.deepEqual(b.npm(), [], "npm never ran");
  assert.deepEqual(b.temps(), [], "every temp folder was removed");

  const checkout = releaseServer();
  const refused = await update(checkout, repoRoot);
  assert.equal(refused.status, 1);
  assert.match(refused.err, new RegExp(`not an npm --global install.*npm i -g ${asset("9.0.0", tgzName("9.0.0")).replace(/[.]/g, "\\.")}`));
  assert.equal(checkout.calls.length, 1, "nothing was downloaded");
}));

// Protects the install path and the one-time question: npm gets the verified local file and this copy's prefix, one
// rollback entry is recorded, a TTY asks [Y/n] then [y/N] once, and "n" is remembered.
test("update installs the verified file with npm, records one rollback entry and asks about auto once", () => withBox(async (b) => {
  const plain = quiet();
  assert.equal(await runUpdate({ action: "install" }, { env: b.env, ...plain, fetch: releaseServer().fetch, root: b.root }), 0, plain.stderr.text);
  const [call] = b.npm();
  assert.deepEqual(call.args.slice(0, 4), ["install", "--global", "--prefix", b.prefix]);
  assert.match(call.args[4], new RegExp(`^${b.env.TMPDIR}/${NAME}-update-[^/]+/${tgzName("9.0.0").replace(/[.]/g, "\\.")}$`));
  assert.equal(call.sha, sha(tarball("9.0.0")), "npm got the verified bytes");
  assert.deepEqual(b.temps(), []);
  assert.equal(plain.stdout.text, `${NAME} ${VERSION} -> 9.0.0\n  Fixes a bug.\n  Second line.\ninstalled 9.0.0; it applies on the next run\n`);
  assert.equal(plain.stderr.text, "", "no questions without a terminal");
  const { previous } = readState(b.env);
  assert.deepEqual({ ...previous, at: 0 }, {
    version: VERSION, tgzUrl: asset(VERSION, tgzName(VERSION)), sumsUrl: asset(VERSION, "SHA256SUMS"), installed: "9.0.0", at: 0,
  });

  // A terminal: answer each question when it appears.
  const terminal = (answers) => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stderr = sink(true);
    const write = stderr.write.bind(stderr);
    stderr.write = (chunk) => {
      const asked = /\[(?:Y\/n|y\/N)\] $/.test(String(chunk));
      write(chunk);
      if (asked) setImmediate(() => stdin.write(`${answers.shift()}\n`));
      return true;
    };
    return { stdin, stderr, stdout: sink(true) };
  };
  const declined = terminal(["n"]);
  assert.equal(await runUpdate({ action: "install" }, { env: b.env, ...declined, fetch: releaseServer({ latest: "9.1.0" }).fetch, root: b.root }), 0);
  assert.match(declined.stdout.text, /not installed\n$/);
  assert.equal(b.npm().length, 1, "declined: npm did not run");

  const yesNo = terminal(["", "n"]);
  assert.equal(await runUpdate({ action: "install" }, { env: b.env, ...yesNo, fetch: releaseServer({ latest: "9.1.0" }).fetch, root: b.root }), 0);
  assert.match(yesNo.stderr.text, /Install 9\.1\.0 now\? \[Y\/n\] /);
  assert.match(yesNo.stderr.text, /Install future updates automatically\? \[y\/N\] /);
  assert.equal(b.npm().length, 2, "Enter means yes");
  assert.equal(readState(b.env).auto, false);
  assert.equal(readState(b.env).askedAuto, true);

  const again = terminal([""]);
  assert.equal(await runUpdate({ action: "install" }, { env: b.env, ...again, fetch: releaseServer({ latest: "9.2.0" }).fetch, root: b.root }), 0);
  assert.doesNotMatch(again.stderr.text, /future updates/, "never asked again after n");
  assert.equal(b.npm().length, 3);
}));

// Protects rollback: the recorded previous release is verified like any other and then cleared; a mismatch refuses
// and keeps the entry; the entry expires after the new version ran once or after seven days.
test("rollback verifies and reinstalls the previous release; the entry is bounded", () => withBox(async (b) => {
  await runUpdate({ action: "install" }, { env: b.env, ...quiet(), fetch: releaseServer().fetch, root: b.root });
  const tampered = quiet();
  assert.equal(await runUpdate({ action: "rollback" }, { env: b.env, ...tampered, fetch: releaseServer({ tamper: VERSION }).fetch, root: b.root }), 1);
  assert.match(tampered.stderr.text, /checksum mismatch/);
  assert.ok(readState(b.env).previous, "kept after a refused rollback");
  assert.equal(b.npm().length, 1);

  const restored = quiet();
  assert.equal(await runUpdate({ action: "rollback" }, { env: b.env, ...restored, fetch: releaseServer().fetch, root: b.root }), 0, restored.stderr.text);
  assert.equal(restored.stdout.text, `restored ${NAME} ${VERSION}; it applies on the next run (9.0.0 is skipped)\n`);
  assert.equal(readState(b.env).skipped, "9.0.0", "the version rolled back from is not announced again");
  assert.equal(b.npm()[1].sha, sha(tarball(VERSION)));
  assert.equal(readState(b.env).previous, null);
  const none = quiet();
  assert.equal(await runUpdate({ action: "rollback" }, { env: b.env, ...none, root: b.root }), 1);
  assert.match(none.stderr.text, /no previous version is recorded/);
  assert.deepEqual(b.temps(), []);

  const entry = { version: "0.1.1", tgzUrl: "https://x/a.tgz", sumsUrl: "https://x/SHA256SUMS", installed: "0.2.0", at: 1_000 };
  writeState(b.env, { ...readState(b.env), previous: entry });
  prunePrevious({ env: b.env, current: "0.1.1", now: 2_000 });
  assert.deepEqual(readState(b.env).previous, entry, "kept until the new version runs");
  prunePrevious({ env: b.env, current: "0.2.0", now: 2_000 });
  assert.equal(readState(b.env).previous, null, "cleared once the new version ran");
  writeState(b.env, { ...readState(b.env), previous: entry });
  prunePrevious({ env: b.env, current: "0.1.1", now: 1_000 + 7 * DAY });
  assert.equal(readState(b.env).previous, null, "cleared after seven days");
}));

// Protects the log bound: one file that never passes 256 KB, even for one oversized line.
test("the background-install log is one file of at most 256 KB", () => withBox(async (b) => {
  appendLog(b.env, "x".repeat(LOG_LIMIT + 10_000));
  assert.ok(statSync(logPath(b.env)).size <= LOG_LIMIT);
  for (let i = 0; i < 400; i++) {
    appendLog(b.env, `line ${i} ${"y".repeat(1_000)}`);
    assert.ok(statSync(logPath(b.env)).size <= LOG_LIMIT, `after line ${i}`);
  }
  assert.match(readFileSync(logPath(b.env), "utf8"), /line 399 y+\n$/);
  assert.deepEqual(readdirSync(b.cache), ["update.log"]);
  assert.equal(statSync(logPath(b.env)).mode & 0o777, 0o600);
}));

// Protects the opt-in background install end to end: a copy laid out as an npm --global install starts a detached
// process that downloads from a local server, verifies, runs npm and logs; a failed install records its cause,
// keeps the current version and brings the notice back.
test("auto on: a detached process installs the verified release; a failure falls back to the notice", { timeout: 60_000 }, () => withBox(async (b) => {
  mkdirSync(join(b.root, "codex-bridge"), { recursive: true });
  copyFileSync(join(repoRoot, "package.json"), join(b.root, "package.json"));
  copyFileSync(join(repoRoot, "codex-bridge", "update.mjs"), join(b.root, "codex-bridge", "update.mjs"));
  const installed = await import(pathToFileURL(join(b.root, "codex-bridge", "update.mjs")).href);

  let server, tamper;
  const handler = async (req, res) => {
    const reply = releaseServer({ base: server.base, tamper }).respond(`${server.base}${req.url}`);
    res.writeHead(reply.status, { "content-type": "application/octet-stream" });
    res.end(Buffer.from(await reply.arrayBuffer()));
  };
  server = http.createServer((req, res) => { handler(req, res); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  server.base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...b.env, CODEX_ON_CLAUDE_CODE_UPDATE_API: `${server.base}/repos/o/r/releases/latest` };
  const waitForLog = async (pattern) => {
    for (let i = 0; i < 400; i++) {
      const text = existsSync(logPath(env)) ? readFileSync(logPath(env), "utf8") : "";
      if (pattern.test(text)) return text;
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.fail(`log never matched ${pattern}`);
  };
  try {
    const opted = quiet();
    await installed.runUpdate({ action: "auto", value: "on" }, { env, ...opted });
    await installed.checkForUpdate({ env, force: true });
    const stderr = sink(true);
    await installed.afterCommand(undefined, { env, stderr });
    assert.equal(stderr.text, "", "auto on: no notice, the install runs instead");
    await waitForLog(/installed 9\.0\.0; it applies on the next run/);
    const [call] = b.npm();
    assert.deepEqual(call.args.slice(0, 4), ["install", "--global", "--prefix", b.prefix]);
    assert.equal(call.sha, sha(tarball("9.0.0")));
    await installed.afterCommand(undefined, { env, stderr });
    assert.equal(b.npm().length, 1, "the same version is not installed twice");

    tamper = "9.0.0";
    writeState(env, { ...readState(env), autoVersion: null });
    await installed.afterCommand(undefined, { env, stderr });
    await waitForLog(/install of 9\.0\.0 failed: checksum mismatch/);
    assert.equal(b.npm().length, 1, "npm did not run for the bad tarball");
    assert.match(readState(env).autoError, /checksum mismatch/);
    await installed.afterCommand(undefined, { env, stderr });
    assert.match(stderr.text, /9\.0\.0 available/, "falls back to the notice");
    const status = quiet();
    await installed.runUpdate({ action: "auto", value: "status" }, { env, ...status });
    assert.match(status.stdout.text, /^automatic updates: on \(last background install of 9\.0\.0 failed: checksum mismatch/);
    assert.deepEqual(readdirSync(b.cache).sort(), ["update.json", "update.log"]);
    assert.deepEqual(b.temps(), []);
  } finally { await new Promise((done) => server.close(done)); }
}));

// Protects neutrality: the update code and its docs carry no email address, personal home path or account id.
test("update code and docs contain no emails or home paths", () => {
  for (const file of ["codex-bridge/update.mjs", "codex-bridge/bridge.mjs", "docs/updates.md", "PRIVACY.md", "README.md", "CHANGELOG.md"]) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}|\/Users\/[a-z]|\/home\/[a-z]|C:\\Users\\/i, file);
  }
});

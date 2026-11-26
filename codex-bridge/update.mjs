/**
 * Update check and self-update (update contract v1).
 *
 * The check is one anonymous GET to the public GitHub "latest release" record of the repository named in
 * package.json, at most once per 24 hours, cached in one private state file. `update` downloads the release tarball
 * into a temp folder, checks it against the release's SHA256SUMS, and only then runs `npm install --global` on that
 * verified file. Automatic installs are opt-in and run detached, at low priority, logging to one bounded file.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants as fsConstants, fchmodSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir, setPriority, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const NAME = PACKAGE.name;
export const VERSION = PACKAGE.version;
export const USER_AGENT = `${NAME}-update-check`;
export const DAY_MS = 24 * 60 * 60 * 1_000;
export const LOG_LIMIT = 256 * 1_024;
const CHECK_TIMEOUT_MS = 4_000;
const ROLLBACK_MS = 7 * DAY_MS;
/** The folder this copy runs from; Node resolves symlinks, so an `npm link` points at the checkout. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** A wrapped command with one of these flags writes machine-readable output: no automatic check then. */
const MACHINE_FLAGS = ["--json", "--experimental-json", "--output-schema"];

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

/** owner/repo from package.json's repository URL, so the check follows the package's own metadata. */
export function repositorySlug(pkg = PACKAGE) {
  const match = /github\.com[:/]([^/]+\/[^/#]+?)(?:\.git)?(?:[/#]|$)/.exec(String(pkg.repository?.url ?? pkg.repository ?? ""));
  if (!match) throw new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_NO_REPO", "package.json names no GitHub repository");
  return match[1];
}

/** Stable x.y.z (optional leading v) as numbers; prereleases and anything else are null. */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
}

/** True only when `candidate` is a stable version strictly newer than `current`. */
export function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] > b[i];
}

// ---- state: one small private file ------------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  lastCheck: 0, // time of the last check, successful or failed
  error: null, // cause of the last failed check
  latest: null, // newest stable release seen, with its two asset URLs
  tgzUrl: null,
  sumsUrl: null,
  skipped: null, // version hidden by `update --skip`
  shownVersion: null, // last notice, for the once-a-day rule
  shownAt: 0,
  checks: true, // `update --checks on|off`
  auto: false, // `update --auto on|off`; off by default
  askedAuto: false, // the [y/N] question has been answered
  autoVersion: null, // last background install attempt and its failure cause
  autoError: null,
  previous: null, // the one rollback entry: { version, tgzUrl, sumsUrl, installed, at }
});

/** The platform cache folder: XDG_CACHE_HOME when set, else ~/Library/Caches, %LOCALAPPDATA% or ~/.cache. */
export function cacheDir(env = process.env) {
  const home = env.HOME || homedir();
  const base = env.XDG_CACHE_HOME
    || (process.platform === "darwin" ? join(home, "Library", "Caches")
      : process.platform === "win32" ? env.LOCALAPPDATA || join(home, "AppData", "Local")
        : join(home, ".cache"));
  return join(base, NAME);
}
export const statePath = (env = process.env) => join(cacheDir(env), "update.json");
export const logPath = (env = process.env) => join(cacheDir(env), "update.log");

export function readState(env = process.env) {
  let raw;
  try { raw = JSON.parse(readFileSync(statePath(env), "utf8")); } catch { raw = undefined; }
  const state = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return state;
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (key !== "previous" && (fallback === null ? typeof raw[key] === "string" : typeof raw[key] === typeof fallback)) state[key] = raw[key];
  }
  const p = raw.previous;
  if (p && typeof p.version === "string" && typeof p.tgzUrl === "string" && typeof p.sumsUrl === "string") state.previous = p;
  return state;
}

/** Atomic replace (temp file + rename), file 0600 in a 0700 folder; the temp file never outlives the call. */
export function writeState(env, state) {
  const path = statePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try { fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify(state)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
}

/** One log file for background installs; the older half is dropped before it can pass LOG_LIMIT. */
export function appendLog(env, line) {
  const path = logPath(env);
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch {}
  text += `${new Date().toISOString()} ${line}\n`;
  if (Buffer.byteLength(text) > LOG_LIMIT) text = Buffer.from(text).subarray(-LOG_LIMIT / 2).toString("utf8");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

/** `update --auto off` removes every file the updater wrote. */
export function removeState(env = process.env) {
  for (const path of [statePath(env), logPath(env)]) rmSync(path, { force: true });
  try { rmdirSync(cacheDir(env)); } catch {} // the folder too, when nothing else is in it
}

/** The one rollback entry goes once the new version has run successfully, or after seven days. */
export function prunePrevious({ env = process.env, current = VERSION, now = Date.now() } = {}) {
  const state = readState(env);
  if (state.previous && (state.previous.installed === current || !(now - state.previous.at < ROLLBACK_MS))) {
    writeState(env, { ...state, previous: null });
  }
}

// ---- check ------------------------------------------------------------------------------------------------------

const cause = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
const firstLines = (text, n = 4) => String(text ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(0, n);

export const releaseApi = (env = process.env) =>
  env.CODEX_ON_CLAUDE_CODE_UPDATE_API || `https://api.github.com/repos/${repositorySlug()}/releases/latest`;

/** The release record -> { version, notes, tgzUrl, sumsUrl }; null for drafts, prereleases and non-x.y.z tags. */
export function parseRelease(json) {
  const parsed = json && !json.draft && !json.prerelease && parseVersion(json.tag_name);
  if (!parsed) return null;
  const version = parsed.join(".");
  const assets = Array.isArray(json.assets) ? json.assets : [];
  const url = (name) => assets.find((a) => a?.name === name && typeof a.browser_download_url === "string")?.browser_download_url ?? null;
  return { version, notes: firstLines(json.body), tgzUrl: url(`${NAME}-${version}.tgz`), sumsUrl: url("SHA256SUMS") };
}

/**
 * One anonymous GET (fixed User-Agent, no query, no id), skipped while the last check is under 24 hours old unless
 * `force`. A failed request is cached with its cause, not thrown. Resolves to { state, notes }.
 */
export async function checkForUpdate({ env = process.env, fetch = globalThis.fetch, now = Date.now(), force = false } = {}) {
  const state = readState(env);
  if (!force && state.lastCheck > 0 && state.lastCheck <= now && now - state.lastCheck < DAY_MS) return { state, notes: [] };
  let next, notes = [];
  try {
    const response = await fetch(releaseApi(env), {
      headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`release API returned HTTP ${response.status}`);
    const release = parseRelease(await response.json());
    notes = release?.notes ?? [];
    next = { ...state, lastCheck: now, error: null, latest: release?.version ?? null, tgzUrl: release?.tgzUrl ?? null, sumsUrl: release?.sumsUrl ?? null };
  } catch (error) {
    next = { ...state, lastCheck: now, error: cause(error) };
  }
  writeState(env, next);
  return { state: next, notes };
}

/** Automatic checks are for a person at a terminal: never in pipes, CI, agent hosts, machine output or after opt-out. */
export function checksAllowed({ args = [], env = process.env, stdout, stderr, stdin = process.stdin } = {}) {
  if (!stdout?.isTTY || !stderr?.isTTY || !stdin?.isTTY) return false;
  if (env.CI !== undefined || env.CODEX_ON_CLAUDE_CODE_NO_UPDATE_CHECK === "1" || env.CLAUDECODE === "1") return false;
  if (args.some((arg) => MACHINE_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) return false;
  return readState(env).checks;
}

export function noticeLines(current, latest, { dim = false } = {}) {
  const second = `turn on automatic updates: ${NAME} update --auto on · skip: ${NAME} update --skip`;
  return [`${NAME} ${latest} available (you have ${current}) · run: ${NAME} update`, dim ? `\u001b[2m${second}\u001b[0m` : second];
}

/**
 * After the wrapped command ends: start an opted-in background install, or write the two-line notice to stderr
 * (at most once a day per version, never for a skipped version). Never throws.
 */
export async function afterCommand(pending, { env = process.env, stderr = process.stderr, current = VERSION, now = Date.now() } = {}) {
  try {
    await pending;
    const state = readState(env);
    const latest = state.latest;
    if (!isNewer(latest, current) || state.skipped === latest) return;
    if (state.auto && state.autoVersion !== latest) {
      writeState(env, { ...state, autoVersion: latest, autoError: null });
      launchAutoInstall({ env, version: latest });
      return;
    }
    if (state.auto && !state.autoError) return; // installing or installed; the new version applies on the next run
    if (state.shownVersion === latest && state.shownAt <= now && now - state.shownAt < DAY_MS) return;
    stderr.write(`${noticeLines(current, latest, { dim: !env.NO_COLOR }).join("\n")}\n`);
    writeState(env, { ...state, shownVersion: latest, shownAt: now });
  } catch {
    // The check records its own failures; nothing here may add noise to the command's output.
  }
}

// ---- install ----------------------------------------------------------------------------------------------------

/**
 * The npm prefix that owns this copy, or null when it is not an `npm install --global` of the release tarball
 * (a git checkout, `npm link`, or a project's local node_modules). Only that install kind is replaced.
 */
export function npmPrefix(root = PACKAGE_ROOT) {
  const dir = resolve(root);
  const modules = dirname(dir);
  if (basename(dir) !== NAME || basename(modules) !== "node_modules") return null;
  const parent = dirname(modules);
  if (process.platform === "win32") return parent;
  return basename(parent) === "lib" ? dirname(parent) : null;
}

async function get(fetch, url, timeoutMs) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_DOWNLOAD", `${basename(new URL(url).pathname)} returned HTTP ${response.status}`);
  return response;
}

/** Download `file` to `target` only if its SHA-256 matches its line in SHA256SUMS. */
async function downloadVerified({ tgzUrl, sumsUrl }, file, target, fetch) {
  const sums = await (await get(fetch, sumsUrl, 10_000)).text();
  const line = sums.split("\n").map((row) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(row.trim())).find((m) => m && basename(m[2]) === file);
  if (!line) throw new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_CHECKSUM", `SHA256SUMS has no entry for ${file}; nothing was installed`);
  const bytes = Buffer.from(await (await get(fetch, tgzUrl, 60_000)).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== line[1].toLowerCase()) {
    throw new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_CHECKSUM", `checksum mismatch for ${file}; nothing was installed`);
  }
  writeFileSync(target, bytes, { mode: 0o600 });
}

function npmInstall(file, prefix, env) {
  return new Promise((done, fail) => {
    const child = spawn("npm", ["install", "--global", "--prefix", prefix, file], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", (chunk) => { output = (output + chunk).slice(-1_000); });
    child.once("error", (error) => fail(new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_INSTALL", `could not run npm: ${error.code ?? error.message}`)));
    child.once("close", (code, signal) => code === 0 ? done()
      : fail(new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_INSTALL", `npm install failed (${signal ?? `exit ${code}`}): ${cause(output)}`)));
  });
}

/**
 * Verify, then install one release with npm; the temp folder is removed on success and on failure. A refusal or a
 * failed npm run leaves the current version in place.
 */
async function installVerified(release, { env, fetch, prefix }) {
  const file = `${NAME}-${release.version}.tgz`;
  if (!release.tgzUrl || !release.sumsUrl) {
    throw new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_ASSET_MISSING", `release ${release.version} has no ${file} or SHA256SUMS asset; nothing was installed`);
  }
  for (const url of [release.tgzUrl, release.sumsUrl]) {
    if (!url.startsWith("https://") && !env.CODEX_ON_CLAUDE_CODE_UPDATE_API) throw new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_ASSET_MISSING", `refusing a non-HTTPS download: ${url}`);
  }
  const temp = mkdtempSync(join(env.TMPDIR || tmpdir(), `${NAME}-update-`));
  try {
    const target = join(temp, file);
    await downloadVerified(release, file, target, fetch);
    await npmInstall(target, prefix, env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const notManaged = (version, url) => new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_NOT_NPM",
  `this copy is not an npm --global install of a release, so it is not replaced. Install ${version} with: npm i -g ${url ?? `the .tgz from https://github.com/${repositorySlug()}/releases`}`);

/** The same release asset URLs under another version's tag, for the rollback entry. */
function assetsFor(release, version) {
  const swap = (url, name) => url?.replace(`/v${release.version}/${name(release.version)}`, `/v${version}/${name(version)}`);
  const tgzUrl = swap(release.tgzUrl, (v) => `${NAME}-${v}.tgz`), sumsUrl = swap(release.sumsUrl, () => "SHA256SUMS");
  return tgzUrl !== release.tgzUrl && sumsUrl !== release.sumsUrl ? { version, tgzUrl, sumsUrl } : null;
}

/** Install a newer release and keep one rollback entry pointing at the version that was running. */
export async function installRelease(release, { env = process.env, fetch = globalThis.fetch, current = VERSION, root = PACKAGE_ROOT, now = Date.now() } = {}) {
  const prefix = npmPrefix(root);
  if (!prefix) throw notManaged(release.version, release.tgzUrl);
  await installVerified(release, { env, fetch, prefix });
  const previous = assetsFor(release, current);
  writeState(env, { ...readState(env), previous: previous && { ...previous, installed: release.version, at: now } });
}

/** `update --rollback`: reinstall the recorded previous release, verified the same way, and skip the one left. */
export async function rollback({ env = process.env, fetch = globalThis.fetch, root = PACKAGE_ROOT } = {}) {
  const { previous } = readState(env);
  if (!previous) throw new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_NO_ROLLBACK", "no previous version is recorded (it is kept until the new version has run once, at most seven days)");
  const prefix = npmPrefix(root);
  if (!prefix) throw notManaged(previous.version, previous.tgzUrl);
  await installVerified(previous, { env, fetch, prefix });
  writeState(env, { ...readState(env), previous: null, skipped: previous.installed ?? null });
  return previous;
}

/** Opted-in background install: a detached, low-priority node process; its output goes to the bounded log only. */
export function launchAutoInstall({ env = process.env, version }) {
  appendLog(env, `installing ${version} in the background`);
  const script = `import(${JSON.stringify(import.meta.url)}).then((m) => m.autoInstall(process.argv[1]));`;
  const child = spawn(process.execPath, ["-e", script, version], { env, detached: true, stdio: "ignore" });
  child.once("error", () => {});
  if (child.pid) try { setPriority(child.pid, 10); } catch {}
  child.unref();
  return child;
}

/** Body of the background install. A failure keeps the current version, logs and records its cause. */
export async function autoInstall(version, { env = process.env, fetch = globalThis.fetch, root = PACKAGE_ROOT } = {}) {
  const state = readState(env);
  try {
    if (state.latest !== version) throw new UpdateError("CODEX_ON_CLAUDE_CODE_UPDATE_STALE", `the cached release is ${state.latest}, not ${version}`);
    await installRelease({ version, tgzUrl: state.tgzUrl, sumsUrl: state.sumsUrl }, { env, fetch, root });
    appendLog(env, `installed ${version}; it applies on the next run`);
  } catch (error) {
    writeState(env, { ...readState(env), autoError: cause(error) });
    appendLog(env, `install of ${version} failed: ${cause(error)}`);
  }
}

// ---- the `update` command ---------------------------------------------------------------------------------------

/** One line from the terminal (cooked mode echoes it); end of input counts as "no". */
async function ask(question, yesByDefault, { stdin, stderr }) {
  const rl = createInterface({ input: stdin, terminal: false });
  try {
    stderr.write(`${question} `);
    const answer = await new Promise((done) => { rl.once("line", done); rl.once("close", () => done(null)); });
    if (answer === null) return false;
    const value = answer.trim().toLowerCase();
    return value ? value === "y" || value === "yes" : yesByDefault;
  } finally { rl.close(); }
}

/** `update [--check|--skip|--rollback|--auto on|off|status|--checks on|off|status]`. Resolves to the exit code. */
export async function runUpdate({ action, value }, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin,
  fetch = globalThis.fetch, root = PACKAGE_ROOT,
} = {}) {
  const say = (text) => stdout.write(`${text}\n`);
  const tty = Boolean(stdin.isTTY && stderr.isTTY);
  const upToDate = () => { say(`${NAME} ${VERSION} is up to date`); return 0; };
  const checkFailed = (state) => { stderr.write(`${NAME}: update check failed: ${state.error}\n`); return 1; };
  try {
    if (action === "auto" || action === "checks") {
      const state = readState(env);
      const key = action, label = action === "auto" ? "automatic updates" : "automatic update checks";
      if (value === "status") {
        const failed = action === "auto" && state.autoError ? ` (last background install of ${state.autoVersion} failed: ${state.autoError})` : "";
        say(`${label}: ${state[key] ? "on" : "off"}${failed}`);
      } else if (action === "auto" && value === "off") {
        removeState(env);
        say("automatic updates: off (update cache and log removed)");
      } else {
        writeState(env, { ...state, [key]: value === "on", ...(action === "auto" ? { askedAuto: true, autoError: null } : {}) });
        say(`${label}: ${value}`);
      }
      return 0;
    }
    if (action === "rollback") {
      const previous = await rollback({ env, fetch, root });
      say(`restored ${NAME} ${previous.version}; it applies on the next run (${previous.installed} is skipped)`);
      return 0;
    }

    const { state, notes } = await checkForUpdate({ env, fetch, force: action !== "skip" });
    // --skip may use a cached release; --check and the install always ask GitHub once.
    if (state.error && (action !== "skip" || !isNewer(state.latest, VERSION))) return checkFailed(state);
    if (!isNewer(state.latest, VERSION)) return upToDate();
    const latest = state.latest;
    if (action === "check") {
      say(noticeLines(VERSION, latest)[0]);
      for (const line of notes) say(`  ${line}`);
      return 10;
    }
    if (action === "skip") {
      writeState(env, { ...state, skipped: latest });
      say(`skipped ${latest}; a newer release will be announced again`);
      return 0;
    }

    say(`${NAME} ${VERSION} -> ${latest}`);
    for (const line of notes) say(`  ${line}`);
    if (!npmPrefix(root)) throw notManaged(latest, state.tgzUrl);
    if (tty && !await ask(`Install ${latest} now? [Y/n]`, true, { stdin, stderr })) { say("not installed"); return 0; }
    await installRelease({ version: latest, tgzUrl: state.tgzUrl, sumsUrl: state.sumsUrl }, { env, fetch, root });
    say(`installed ${latest}; it applies on the next run`);
    const after = readState(env);
    if (tty && !after.auto && !after.askedAuto) {
      const auto = await ask("Install future updates automatically? [y/N]", false, { stdin, stderr });
      writeState(env, { ...readState(env), auto, askedAuto: true });
      say(`automatic updates: ${auto ? "on" : "off"}`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    stderr.write(`${NAME}: ${error.code}: ${error.message}\n`);
    return 1;
  }
}

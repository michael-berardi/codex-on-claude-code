// Shared test helpers: a temp folder with a fake `claude` and a fake `codex` on PATH, and process checks.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = join(root, "bin", "codex-on-claude-code");
const fixture = (name) => readFileSync(join(root, "test", "fixtures", name), "utf8");

/** Write an executable node script named `name` into `dir`. */
export function writeFake(dir, name, source) {
  writeFileSync(join(dir, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
}

/**
 * A fresh sandbox: `bin/` holds the fakes and is first on PATH; HOME is private, so `~/.codex` is inside it.
 * PATH has only the fakes and the system folders, so no real `claude` or `codex` can be found.
 */
export function sandbox({ claude = true, codex = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "codex-bridge-test-")));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  if (claude) writeFake(bin, "claude", fixture("fake-claude.mjs"));
  if (codex) writeFake(bin, "codex", fixture("fake-codex.mjs"));
  const claudeLog = join(dir, "claude.log");
  const codexOut = join(dir, "codex.json");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    CODEX_HOME: join(dir, "codex-home"),
    FAKE_CLAUDE_LOG: claudeLog,
    FAKE_CODEX_OUT: codexOut,
  };
  const claudeEvents = () => existsSync(claudeLog)
    ? readFileSync(claudeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const codexResult = () => (existsSync(codexOut) ? JSON.parse(readFileSync(codexOut, "utf8")) : undefined);
  // Every process a fake recorded is ours: stop any that a failing test left behind, then remove the folder.
  const recordedPids = () => {
    const out = codexResult() ?? {};
    return [out.pid, out.helper, out.grandchild, ...claudeEvents().flatMap((e) => [e.pid, e.grandchild])].filter(Number.isInteger);
  };
  const cleanup = () => {
    for (const pid of recordedPids()) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, bin, home, env, claudeLog, codexOut, claudeEvents, codexResult, recordedPids, cleanup };
}

/** Start the bridge. `run.done` resolves to { status, signal, stdout, stderr } and is bounded by `timeoutMs`. */
export function start(args, env, { timeoutMs = 60_000, argv = [BIN] } = {}) {
  const child = spawn(process.execPath, [...argv, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    // Resolve on exit; a process that outlived the bridge may hold its pipes open, so do not wait for them long.
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      const finish = () => resolve({ status, signal, stdout, stderr });
      const late = setTimeout(finish, 1_000);
      child.once("close", () => { clearTimeout(late); finish(); });
    });
  });
  return { child, done };
}

export const run = (args, env, options) => start(args, env, options).done;

/** Run `main` from the module directly, without the bin's process.exit: the process ends only if nothing keeps it alive. */
export function runWithoutExit(args, env, options) {
  const url = new URL("../codex-bridge/bridge.mjs", import.meta.url).href;
  const script = `const { main } = await import(${JSON.stringify(url)}); process.exitCode = await main(process.argv.slice(1));`;
  return start(args, env, { ...options, argv: ["--input-type=module", "-e", script] }).done;
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export async function waitFor(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

/** True when something accepts a connection on 127.0.0.1:port. */
export function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Codex CLI on Claude Code: a loopback Responses endpoint that runs every request through the `claude` CLI on the
 * user's own Claude Code login.
 *
 *   codex-on-claude-code exec [--model <id>] [--effort <level>] -- codex [args...]
 *
 * Starts the endpoint on a random 127.0.0.1 port, writes CODEX_HOME/config.toml so Codex's model provider points at
 * it, runs the command after `--`, and exits with that command's exit code. Codex keeps the conversation, the tools,
 * the sandbox and the approvals; Claude Code only generates. Claude Code keeps its own credentials.
 *
 * Translation (Responses API <-> the vocabulary the claude-code module takes):
 * - `instructions` and leading developer messages become the system prompt; user, assistant, function_call and
 *   function_call_output items become user, assistant and tool messages.
 * - Function tools are offered by name; namespaced and hosted tools (web search) are not offered.
 * - Each response starts with one reasoning item whose `encrypted_content` carries the native Anthropic message
 *   (signed thinking included). Codex sends it back with the next request, so the transcript replays exactly.
 * - Usage: input_tokens counts all input; cached_tokens is the cache read, cache_write_tokens the cache write.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import {
  chmodSync, closeSync, constants as fsConstants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { homedir, userInfo, constants as osConstants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createClaudeCodeAdapter } from "../claude-code/adapter.js";
import { resolveClaudeExecutable, processEnvironment } from "../claude-code/claude-cli.js";
import { withTelemetryOff } from "../claude-code/env.js";
import { loadHarness } from "../claude-code/harness.js";
import { VERSION, afterCommand, checkForUpdate, checksAllowed, prunePrevious, runUpdate } from "./update.mjs";

export { VERSION };
export const MARKER = "# codex-on-claude-code managed config";
export const TOKEN_ENV = "CODEX_BRIDGE_TOKEN";
const PROVIDER = "claude-code-bridge";
const CLAUDE_ENV = "CODEX_BRIDGE_CLAUDE_COMMAND";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const KILL_GRACE_MS = 2_000;

export const EXIT = Object.freeze({ USAGE: 64, NOT_FOUND: 127, CANNOT_RUN: 126, CONFIG: 78 });

export const USAGE = `usage: codex-on-claude-code exec [--model <id>] [--effort <level>] -- <command> [args...]
       codex-on-claude-code update [--check | --skip | --rollback | --auto on|off|status | --checks on|off|status]

Runs <command> (normally codex) with CODEX_HOME/config.toml pointing Codex at a
loopback endpoint that generates through your Claude Code login.

options:
  --model <id>      Claude Code model id or alias (default: "default")
  --effort <level>  Codex reasoning effort written to the config
  --help            print this help and exit
  --version         print the version and exit

CODEX_HOME must be set to a private folder that is not ~/.codex.
`;

/** A refusal with a stable name and the exit code it maps to. */
export class BridgeError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function encodeCarrier(replayState) {
  return Buffer.from(JSON.stringify(replayState ?? null), "utf8").toString("base64");
}

function decodeCarrier(value) {
  if (typeof value !== "string" || !value) return undefined;
  try { return JSON.parse(Buffer.from(value, "base64").toString("utf8")) ?? undefined; } catch { return undefined; }
}

/** Responses request body -> { system, messages, tools, skipped } in the module's vocabulary. */
export function translateRequest(body) {
  const systemParts = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) systemParts.push(body.instructions);
  const messages = [];
  let assistant; // the assistant message being assembled from consecutive model-side items
  const closeAssistant = () => {
    if (assistant && assistant.content.length) messages.push(assistant);
    assistant = undefined;
  };
  const openAssistant = () => {
    if (!assistant) assistant = { role: "assistant", id: randomUUID(), content: [], source: { kind: "model" } };
    return assistant;
  };
  let n = 0;
  for (const item of Array.isArray(body.input) ? body.input : []) {
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "reasoning") {
      closeAssistant(); // every response this bridge returns starts with one reasoning item
      const message = openAssistant();
      const carrier = decodeCarrier(item.encrypted_content);
      if (carrier) message.source = { kind: "model", replayState: carrier };
    } else if (type === "message" && item.role === "assistant") {
      const text = textOf(item.content);
      if (text) openAssistant().content.push({ type: "text", text });
    } else if (type === "function_call") {
      openAssistant().content.push({ type: "tool-call", id: item.call_id, name: item.name, arguments: item.arguments ?? "{}" });
    } else if (type === "function_call_output") {
      closeAssistant();
      const output = typeof item.output === "string" ? item.output : textOf(item.output?.content ?? item.output);
      messages.push({ role: "tool", id: `t${n++}`, toolCallId: item.call_id, content: [{ type: "text", text: output }], source: { kind: "tool" } });
    } else if (type === "message" && (item.role === "developer" || item.role === "system")) {
      const text = textOf(item.content);
      if (text.trim()) {
        if (messages.length === 0 && !assistant) systemParts.push(text);
        else { closeAssistant(); messages.push({ role: "user", id: `u${n++}`, content: [{ type: "text", text }], source: { kind: "user" } }); }
      }
    } else if (type === "message" && item.role === "user") {
      closeAssistant();
      const text = textOf(item.content);
      if (text) messages.push({ role: "user", id: `u${n++}`, content: [{ type: "text", text }], source: { kind: "user" } });
    }
  }
  closeAssistant();
  const tools = [];
  const skipped = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (tool.type === "function" && tool.name) tools.push({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } });
    else skipped.push(tool.name ?? tool.type);
  }
  return { system: systemParts.join("\n\n"), messages, tools, skipped };
}

/** Collected adapter chunks -> Responses output items and usage. */
export function buildOutput(chunks) {
  const blocks = [];
  let usage = {};
  let replayState;
  for (const chunk of chunks) {
    if (chunk.type === "block-end") blocks.push(chunk.block);
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "finish") replayState = chunk.replayState;
  }
  const reasoningText = blocks.filter((b) => b.type === "reasoning").map((b) => b.text).join("\n");
  const output = [{
    type: "reasoning", id: `rs_${randomUUID()}`,
    summary: reasoningText ? [{ type: "summary_text", text: reasoningText }] : [],
    encrypted_content: encodeCarrier(replayState),
  }];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (text) output.push({ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  for (const b of blocks) {
    if (b.type === "tool-call") output.push({ type: "function_call", id: `fc_${randomUUID()}`, call_id: String(b.id), name: b.name, arguments: b.arguments || "{}", status: "completed" });
  }
  const i = usage.inputTokens ?? 0, cr = usage.cacheReadTokens ?? 0, cw = usage.cacheWriteTokens ?? 0, o = usage.outputTokens ?? 0;
  return {
    output,
    usage: {
      input_tokens: i + cr + cw,
      input_tokens_details: { cached_tokens: cr, cache_write_tokens: cw },
      output_tokens: o,
      output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
      total_tokens: i + cr + cw + o,
    },
  };
}

function sse(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

/** HTTP status for a failed turn. Billing and setup failures are not retryable; only real rate limits are 429. */
function failureStatus(error) {
  const code = error?.code;
  if (code === "CLAUDE_CODE_BILLING") return 402;
  if (code === "CLAUDE_CODE_NOT_READY" || code === "CLAUDE_CODE_CONFLICTING_ENV") return 503;
  if (code === "CLAUDE_CODE_WAIT_LIMIT") return 504;
  if (code === "CONTEXT_WINDOW_EXCEEDED") return 400;
  if (/\brate.?limit(?:ed)?\b.*(?:exceeded|reached)|\b429\b|overloaded/iu.test(String(error?.message))) return 429;
  return 500;
}

const digest = (value) => createHash("sha256").update(value).digest();

/**
 * Start the loopback endpoint. Every request must carry `Authorization: Bearer <token>`; anything else gets 401
 * before the body is read or the adapter is reached.
 */
export async function startBridge({ adapter, token, log = () => {} }) {
  if (typeof token !== "string" || token.length < 64) throw new Error("bridge token of at least 32 random bytes (64 hex characters) required");
  const expected = digest(`Bearer ${token}`);
  const warned = new Set();
  const inflight = new Set();
  const server = http.createServer(async (req, res) => {
    // Constant time: both sides are hashed to the same length first, so neither content nor length leaks.
    const header = req.headers.authorization;
    if (typeof header !== "string" || !timingSafeEqual(digest(header), expected)) {
      res.writeHead(401, { "content-type": "application/json", connection: "close" }).end('{"error":{"message":"unauthorized"}}');
      req.resume();
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) { req.resume(); res.writeHead(404).end(); return; }
    const abort = new AbortController();
    inflight.add(abort);
    res.on("close", () => { if (!res.writableFinished) abort.abort(new Error("client went away")); });
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "bad JSON" } })); return;
      }
      const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
      if (!isObject(body) || [body.input, body.tools].some((items) => Array.isArray(items) && !items.every(isObject))) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
          error: { message: "expected a request object with object entries in input and tools" },
        }));
        return;
      }
      const id = `resp_${randomUUID()}`;
      const { system, messages, tools, skipped } = translateRequest(body);
      for (const name of skipped) if (!warned.has(name)) { warned.add(name); log(`codex-on-claude-code: tool not offered: ${name}`); }
      const collected = [];
      for await (const chunk of adapter.stream({
        provider: "claude-code", model: body.model, system, messages, tools,
        reasoningEffort: body.reasoning?.effort && body.reasoning.effort !== "none" ? body.reasoning.effort : undefined,
        maxTokens: body.max_output_tokens, sessionId: body.prompt_cache_key, signal: abort.signal,
      })) collected.push(chunk);
      abort.signal.throwIfAborted();
      const { output, usage } = buildOutput(collected);
      let out = sse("response.created", { response: { id, object: "response", status: "in_progress", model: body.model, output: [] } });
      output.forEach((item, index) => {
        out += sse("response.output_item.added", { output_index: index, item: item.type === "message" ? { ...item, content: [], status: "in_progress" } : item });
        if (item.type === "message") out += sse("response.output_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text });
        out += sse("response.output_item.done", { output_index: index, item });
      });
      out += sse("response.completed", { response: { id, object: "response", status: "completed", model: body.model, output, usage } });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).end(out);
    } catch (error) {
      if (abort.signal.aborted) { res.destroy(); return; }
      const message = error instanceof Error ? error.message : String(error);
      log(`codex-on-claude-code: request failed: ${message}`);
      if (!res.headersSent) res.writeHead(failureStatus(error), { "content-type": "application/json" }).end(JSON.stringify({ error: { message, code: error?.code } }));
    } finally {
      inflight.delete(abort);
    }
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { server.off("error", fail); done(); }); });
  /** Abort every in-flight request (and with it the claude child it runs). */
  const abortAll = (reason = new Error("bridge stopping")) => { for (const a of inflight) a.abort(reason); };
  const close = async () => {
    abortAll();
    server.closeAllConnections();
    await new Promise((done) => server.close(() => done()));
  };
  return { server, url: `http://127.0.0.1:${server.address().port}/v1`, abortAll, close };
}

/** The Codex config. It names the token's environment variable, never the token. */
export function configToml({ url, model, effort }) {
  return [
    MARKER,
    `model = ${JSON.stringify(model)}`,
    `model_provider = ${JSON.stringify(PROVIDER)}`,
    ...(effort ? [`model_reasoning_effort = ${JSON.stringify(effort)}`] : []),
    "",
    `[model_providers.${PROVIDER}]`,
    `name = "Claude Code (subscription login)"`,
    `base_url = ${JSON.stringify(url)}`,
    `env_key = ${JSON.stringify(TOKEN_ENV)}`,
    `wire_api = "responses"`,
    `request_max_retries = 0`,
    `stream_max_retries = 0`,
    `stream_idle_timeout_ms = 900000`,
    "",
    `[shell_environment_policy]`,
    `exclude = [${JSON.stringify(TOKEN_ENV)}]`,
    "",
  ].join("\n");
}

const bad = (why) => new BridgeError("CODEX_BRIDGE_USAGE", `${why}\n\n${USAGE}`, EXIT.USAGE);

/** Parse `update [option]`: at most one option; --auto and --checks take on, off or status. */
export function parseUpdateArgs(opts) {
  const [flag, value, ...rest] = opts;
  if (flag === undefined) return { update: true, action: "install" };
  if (!["--check", "--skip", "--rollback", "--auto", "--checks"].includes(flag)) throw bad(`unknown update option: ${flag}`);
  const takesValue = flag === "--auto" || flag === "--checks";
  if (takesValue && !["on", "off", "status"].includes(value)) throw bad(`${flag} needs on, off or status`);
  if (rest.length || (!takesValue && value !== undefined)) throw bad("update takes one option");
  return { update: true, action: flag.slice(2), value };
}

/** Parse `exec [options] -- command...`. Returns { help } / { version } / { update, action, value } / exec fields. */
export function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") return { help: true };
  if (argv[0] === "--version") return { version: true };
  if (argv[0] === "update") return parseUpdateArgs(argv.slice(1));
  if (argv[0] !== "exec") throw bad(argv.length ? `unknown command or option: ${argv[0]}` : "missing command: exec");
  const sep = argv.indexOf("--");
  const opts = sep < 0 ? argv.slice(1) : argv.slice(1, sep);
  let model = "default", effort;
  for (let i = 0; i < opts.length; i++) {
    const name = opts[i];
    if (name !== "--model" && name !== "--effort") throw bad(`unknown option: ${name}`);
    const value = opts[i + 1];
    if (!value || value.startsWith("-")) throw bad(`${name} needs a value`);
    if (name === "--model") model = value; else effort = value;
    i++;
  }
  if (sep < 0) throw bad("missing `--` before the command to run");
  const [command, ...args] = argv.slice(sep + 1);
  return { model, effort, command, args };
}

/** The real path of `path`, also for a path that does not exist yet (its nearest existing ancestor is resolved). */
function realPathOf(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realPathOf(parent), basename(absolute));
  }
}

/** Read the start of an existing file without following a symlink; undefined when it does not exist. */
function readHead(path) {
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error.code === "ELOOP") return "";
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MARKER.length + 1);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}

const foreignConfig = (path) => new BridgeError("CODEX_BRIDGE_HOME_FOREIGN_CONFIG",
  `${path} exists and was not written by this bridge (its first line is not "${MARKER}"). ` +
  "It was left unchanged. Use another, empty CODEX_HOME.", EXIT.CONFIG);

/** Check CODEX_HOME without changing anything. Returns its real path (which may not exist yet). */
export function checkCodexHome(env = process.env) {
  if (!env.CODEX_HOME) {
    throw new BridgeError("CODEX_BRIDGE_HOME_UNSET", 'CODEX_HOME is not set. Set it to a private folder, for example CODEX_HOME="$(mktemp -d)".', EXIT.CONFIG);
  }
  const home = realPathOf(env.CODEX_HOME);
  // The real ~/.codex under every name for "home": the given HOME, the process's home, and the account's home.
  const homes = [env.HOME, homedir(), (() => { try { return userInfo().homedir; } catch { return undefined; } })()];
  if (homes.some((h) => h && home === realPathOf(join(h, ".codex")))) {
    throw new BridgeError("CODEX_BRIDGE_HOME_IS_DEFAULT", "CODEX_HOME points at your real ~/.codex. Set it to a separate private folder.", EXIT.CONFIG);
  }
  const config = join(home, "config.toml");
  const head = readHead(config);
  if (head !== undefined && head !== `${MARKER}\n`) throw foreignConfig(config);
  return home;
}

/** Create CODEX_HOME (0700) and write config.toml (0600) without a check-then-write race. */
export function writeCodexConfig(home, text) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const config = join(home, "config.toml");
  const writeAll = (fd) => { fchmodSync(fd, 0o600); writeSync(fd, text); fsyncSync(fd); };
  const createFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  // A new file: exclusive create, so a file that appeared since the check is never overwritten.
  let fd;
  try { fd = openSync(config, createFlags, 0o600); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (fd !== undefined) {
    try { writeAll(fd); } finally { closeSync(fd); }
    return config;
  }
  // An existing file: it must still carry the marker; replace it by renaming a private temp file over it.
  if (!lstatSync(config).isFile() || readHead(config) !== `${MARKER}\n`) throw foreignConfig(config);
  const temp = join(home, `.config.toml.${randomBytes(8).toString("hex")}.tmp`);
  fd = openSync(temp, createFlags, 0o600);
  try {
    try { writeAll(fd); } finally { closeSync(fd); }
    renameSync(temp, config);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  return config;
}

async function findExecutable(command, env) {
  return resolveClaudeExecutable({ ...env, [CLAUDE_ENV]: command });
}

/** Everything that can be refused before the endpoint starts listening. */
async function preflight(parsed, env) {
  const home = checkCodexHome(env);
  if (!parsed.command) {
    throw new BridgeError("CODEX_BRIDGE_COMMAND_MISSING", "no command after `--`. Put the command to run after it, for example: -- codex", EXIT.USAGE);
  }
  if (!await findExecutable(parsed.command, env)) {
    throw new BridgeError("CODEX_BRIDGE_COMMAND_NOT_FOUND", `the command "${parsed.command}" was not found or is not executable. Install it or pass its full path after \`--\`.`, EXIT.NOT_FOUND);
  }
  if (!await resolveClaudeExecutable(env)) {
    throw new BridgeError("CODEX_BRIDGE_CLAUDE_NOT_FOUND", env[CLAUDE_ENV]
      ? `${CLAUDE_ENV} names "${env[CLAUDE_ENV]}", which was not found or is not executable. Fix the path or unset ${CLAUDE_ENV}.`
      : `the claude CLI was not found on PATH. Install Claude Code (npm install -g @anthropic-ai/claude-code) or set ${CLAUDE_ENV} to its path.`, EXIT.NOT_FOUND);
  }
  try { processEnvironment(env, {}); } catch (error) {
    // The module's message names the variables only, never their values.
    throw new BridgeError("CODEX_BRIDGE_CONFLICTING_ENV", error.message, EXIT.CONFIG);
  }
  return home;
}

/**
 * Run the bridge. Resolves to the exit code; writes help, version and errors itself.
 * `io.stdout`/`io.stderr` are writable streams; tests may pass their own, and `io.stdin`/`io.fetch` for updates.
 */
export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, fetch = globalThis.fetch,
} = {}) {
  const say = (stream, text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);
  let parsed, home;
  try {
    parsed = parseArgs(argv);
    if (parsed.help) { say(stdout, USAGE); return 0; }
    if (parsed.version) { say(stdout, VERSION); return 0; }
    if (parsed.update) return await runUpdate(parsed, { env, stdout, stderr, stdin, fetch });
    home = await preflight(parsed, env);
  } catch (error) {
    if (error instanceof BridgeError) { say(stderr, `codex-on-claude-code: ${error.code}: ${error.message}`); return error.exitCode; }
    throw error;
  }

  // The update check runs alongside the command (bounded to 4 s, never awaited before it starts); its notice, if any,
  // comes after the command has finished.
  const check = checksAllowed({ args: parsed.args, env, stdout, stderr, stdin })
    ? checkForUpdate({ env, fetch }).catch(() => {}) : undefined;

  const log = (message) => say(stderr, message);
  const harness = await loadHarness();
  const adapter = createClaudeCodeAdapter(harness, { env: () => env, report: log });
  const token = randomBytes(32).toString("hex");
  const bridge = await startBridge({ adapter, token, log });
  let child;
  let received;
  let killTimer;
  // In a terminal the command stays in the terminal's foreground process group so it can read the keyboard;
  // otherwise it gets its own group, and stopping the bridge stops that whole group.
  const ownGroup = process.platform !== "win32" && !process.stdin.isTTY;
  const killChild = (signal) => {
    if (!child?.pid) return;
    try { if (ownGroup) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
  };
  const onSignal = (signal) => {
    if (received) { killChild("SIGKILL"); return; }
    received = signal;
    bridge.abortAll(new Error(`bridge received ${signal}`));
    killChild(signal);
    killTimer = setTimeout(() => killChild("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  try {
    try { writeCodexConfig(home, configToml({ url: bridge.url, model: parsed.model, effort: parsed.effort })); } catch (error) {
      if (error instanceof BridgeError) { say(stderr, `codex-on-claude-code: ${error.code}: ${error.message}`); return error.exitCode; }
      throw error;
    }
    if (received) return 128 + osConstants.signals[received];
    // The token reaches the command only through its environment, under the name the config's env_key gives.
    // The wrapped command (normally Codex) is launched with telemetry off. Model/auth variables are untouched.
    child = spawn(parsed.command, parsed.args, { stdio: "inherit", detached: ownGroup, env: withTelemetryOff({ ...env, CODEX_HOME: home, [TOKEN_ENV]: token }) });
    const result = await new Promise((done) => {
      child.once("error", (error) => { say(stderr, `codex-on-claude-code: CODEX_BRIDGE_COMMAND_FAILED: could not start "${parsed.command}": ${error.code ?? error.message}`); done(EXIT.CANNOT_RUN); });
      child.once("exit", (code, signal) => done(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)));
    });
    if (received) return 128 + osConstants.signals[received];
    if (result === 0) try { prunePrevious({ env }); } catch {}
    if (check) await afterCommand(check, { env, stderr });
    return result;
  } finally {
    // A request still in flight when the command exits is aborted, and its claude child stopped.
    clearTimeout(killTimer);
    await bridge.close();
    await adapter.close();
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  }
}

// The bridge as a process: fake `claude` and fake `codex` on PATH, the real bin in between.
// Each test names the guard it protects; removing that guard makes the test fail.
import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { checkCodexHome, MARKER, startBridge, writeCodexConfig } from "../codex-bridge/bridge.mjs";
import { alive, listening, run, runWithoutExit, sandbox, start, waitFor } from "./helpers.js";

const EXEC = ["exec", "--model", "default", "--"];
const TIMEOUT = { timeout: 120_000 }; // a busy machine: generous per-test limits

/** Run fn with a fresh sandbox, always removed afterwards. */
async function withSandbox(options, fn) {
  const box = sandbox(options);
  try { return await fn(box); } finally { box.cleanup(); }
}

// Protects the translation both ways: function tool call out, tool result back in, final message, usage mapping,
// and the once-only notice for tools the bridge cannot offer.
test("end to end: tool call, tool result, final message, usage", TIMEOUT, () => withSandbox({}, async (box) => {
  const result = await run([...EXEC, "codex"], {
    ...box.env, FAKE_CODEX_MODE: "roundtrip", FAKE_CLAUDE_MODE: "tool-then-text",
    FAKE_CLAUDE_TOOL_INPUT: JSON.stringify({ cmd: "ls" }), FAKE_CLAUDE_TEXT: "listed",
  });
  assert.equal(result.status, 0, result.stderr);
  const out = box.codexResult();
  const first = out.first.completed;
  assert.deepEqual(first.output.map((i) => i.type), ["reasoning", "message", "function_call"]);
  const call = first.output[2];
  assert.equal(call.name, "exec_command");
  assert.deepEqual(JSON.parse(call.arguments), { cmd: "ls" });
  assert.deepEqual(first.usage, {
    input_tokens: 19, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
    output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 26,
  });
  const second = out.second.completed;
  assert.equal(second.output.find((i) => i.type === "message").content[0].text, "listed");
  assert.equal(second.output.some((i) => i.type === "function_call"), false);
  const queries = box.claudeEvents().filter((e) => e.event === "query");
  assert.equal(queries.length, 2);
  assert.ok(queries[1].blocks.includes("tool_result"), "the tool result reached Claude Code");
  // Tools the bridge cannot offer are named once each, and the run still succeeds.
  assert.equal(result.stderr.match(/tool not offered: web_search/g)?.length, 1);
  assert.equal(result.stderr.match(/tool not offered: multi_agent_v1/g)?.length, 1);
  for (const launch of box.claudeEvents().filter((e) => e.event === "launch")) assert.equal(alive(launch.pid), false);
}));

// Protects the token's path: it reaches the wrapped command only through the env_key variable, and appears in no
// output, no config file, no argv of codex or claude, and not in claude's environment.
test("the token is in no output, no config file and no argv", TIMEOUT, () => withSandbox({}, async (box) => {
  const result = await run([...EXEC, "codex"], { ...box.env, FAKE_CODEX_MODE: "roundtrip", FAKE_CLAUDE_MODE: "tool-then-text" });
  assert.equal(result.status, 0, result.stderr);
  const out = box.codexResult();
  assert.equal(out.keyName, "CODEX_BRIDGE_TOKEN");
  assert.match(out.token, /^[0-9a-f]{64}$/, "32 random bytes, hex");
  const config = readFileSync(join(box.env.CODEX_HOME, "config.toml"), "utf8");
  for (const [where, text] of [["stdout", result.stdout], ["stderr", result.stderr], ["config", config], ["codex argv", out.argv.join(" ")]]) {
    assert.equal(text.includes(out.token), false, `token found in ${where}`);
  }
  const launches = box.claudeEvents().filter((e) => e.event === "launch");
  assert.ok(launches.length >= 1);
  for (const launch of launches) {
    assert.equal(launch.argv.join(" ").includes(out.token), false, "token in claude argv");
    assert.equal(launch.tokenEnvSet, false, "token in claude environment");
  }
}));

// Protects the bearer check: a missing or wrong token gets 401 and no handler runs, so claude is never started.
test("401 for a missing and a wrong token; claude never starts", TIMEOUT, () => withSandbox({}, async (box) => {
  const result = await run([...EXEC, "codex"], { ...box.env, FAKE_CODEX_MODE: "badauth" });
  assert.equal(result.status, 0, result.stderr);
  const out = box.codexResult();
  assert.equal(out.missing, 401);
  assert.equal(out.wrong, 401);
  assert.deepEqual(box.claudeEvents(), [], "the fake claude was never started");
}));

// Protects the loopback-only bind and the auth check ahead of the adapter, at the server level.
test("the endpoint binds 127.0.0.1 and rejects before the adapter", TIMEOUT, async () => {
  let calls = 0;
  const bridge = await startBridge({ token: "a".repeat(64), adapter: { async *stream() { calls++; } } });
  try {
    assert.equal(bridge.server.address().address, "127.0.0.1");
    assert.equal(bridge.server.address().family, "IPv4");
    for (const headers of [{}, { authorization: `Bearer ${"b".repeat(64)}` }, { authorization: `Bearer ${"a".repeat(63)}` }]) {
      assert.equal((await fetch(`${bridge.url}/responses`, { method: "POST", headers, body: "{}" })).status, 401);
    }
    assert.equal(calls, 0);
  } finally { await bridge.close(); }
});

// Protects the three CODEX_HOME refusals (exit 78, named error, nothing written, nothing started) and the
// overwrite of a bridge-marked config with private permissions.
test("CODEX_HOME: unset, real ~/.codex, foreign config are refused; a marked config is replaced", TIMEOUT, () => withSandbox({}, async (box) => {
  const refused = async (env, code) => {
    const result = await run([...EXEC, "codex"], env);
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, new RegExp(code));
    assert.equal(box.codexResult(), undefined, "the wrapped command did not start");
    assert.deepEqual(box.claudeEvents(), []);
  };
  const { CODEX_HOME: _, ...noHome } = box.env;
  await refused(noHome, "CODEX_BRIDGE_HOME_UNSET");

  const realDefault = join(box.home, ".codex");
  await refused({ ...box.env, CODEX_HOME: realDefault }, "CODEX_BRIDGE_HOME_IS_DEFAULT");
  assert.equal(existsSync(realDefault), false, "~/.codex was not created");
  mkdirSync(realDefault);
  writeFileSync(join(realDefault, "config.toml"), MARKER + "\n"); // even a marked file there is refused
  await refused({ ...box.env, CODEX_HOME: realDefault }, "CODEX_BRIDGE_HOME_IS_DEFAULT");
  const alias = join(box.dir, "alias");
  symlinkSync(realDefault, alias);
  await refused({ ...box.env, CODEX_HOME: alias }, "CODEX_BRIDGE_HOME_IS_DEFAULT");
  await refused({ ...box.env, CODEX_HOME: join(alias, ".") }, "CODEX_BRIDGE_HOME_IS_DEFAULT");

  mkdirSync(box.env.CODEX_HOME);
  const config = join(box.env.CODEX_HOME, "config.toml");
  const foreign = Buffer.from('model = "mine"\n# codex-on-claude-code managed config\nÿ\n', "latin1");
  writeFileSync(config, foreign, { mode: 0o644 });
  const before = statSync(config);
  await refused(box.env, "CODEX_BRIDGE_HOME_FOREIGN_CONFIG");
  assert.deepEqual(readFileSync(config), foreign, "foreign config byte-identical");
  assert.equal(statSync(config).mtimeMs, before.mtimeMs);
  assert.equal(statSync(config).mode & 0o777, 0o644);

  // A symlink named config.toml is foreign too, and its target is not touched.
  const target = join(box.dir, "elsewhere.toml");
  writeFileSync(target, MARKER + "\nold\n");
  const linkHome = join(box.dir, "link-home");
  mkdirSync(linkHome);
  symlinkSync(target, join(linkHome, "config.toml"));
  await refused({ ...box.env, CODEX_HOME: linkHome }, "CODEX_BRIDGE_HOME_FOREIGN_CONFIG");
  assert.equal(readFileSync(target, "utf8"), MARKER + "\nold\n");

  writeFileSync(config, `${MARKER}\nstale = true\n`, { mode: 0o644 });
  const result = await run([...EXEC, "sh", "-c", "exit 0"], box.env);
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(config, "utf8");
  assert.ok(text.startsWith(MARKER + "\n"));
  assert.doesNotMatch(text, /stale/);
  assert.match(text, /^base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"$/m);
  assert.equal(lstatSync(config).mode & 0o777, 0o600);
  assert.equal(statSync(box.env.CODEX_HOME).mode & 0o777, 0o700);
}));

// Protects the new-file path: a fresh CODEX_HOME is created 0700 with a 0600 config.
test("a fresh CODEX_HOME is created private", TIMEOUT, () => withSandbox({}, async (box) => {
  const home = join(box.dir, "new", "nested");
  const result = await run([...EXEC, "sh", "-c", "exit 0"], { ...box.env, CODEX_HOME: home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "config.toml")).mode & 0o777, 0o600);
}));

// Protects exit-code passthrough: 0, 7, and 128 + signal number for a signal death.
test("exit codes pass through: 0, 7, signal death", TIMEOUT, () => withSandbox({}, async (box) => {
  assert.equal((await run([...EXEC, "sh", "-c", "exit 0"], box.env)).status, 0);
  assert.equal((await run([...EXEC, "sh", "-c", "exit 7"], box.env)).status, 7);
  assert.equal((await run([...EXEC, "sh", "-c", "kill -KILL $$"], box.env)).status, 128 + 9);
  assert.equal((await run([...EXEC, "sh", "-c", "kill -TERM $$"], box.env)).status, 128 + 15);
}));

// Protects shutdown on SIGTERM: the wrapped command's group, the in-flight request and its claude child (and its
// own child) are stopped, the listener is gone within 3 s, and the exit code is 128 + 15.
test("SIGTERM stops everything within 3 s", TIMEOUT, () => withSandbox({}, async (box) => {
  const bridge = start([...EXEC, "codex"], { ...box.env, FAKE_CODEX_MODE: "hang", FAKE_CLAUDE_MODE: "hang" });
  const query = await waitFor(() => box.claudeEvents().find((e) => e.event === "query"), 60_000);
  assert.ok(query, "the request reached the fake claude");
  const codex = box.codexResult();
  assert.ok(await listening(codex.port));
  const claudePids = box.claudeEvents().filter((e) => e.event === "launch").map((e) => e.pid);
  const sent = Date.now();
  bridge.child.kill("SIGTERM");
  const pids = [codex.pid, codex.grandchild, ...claudePids, query.grandchild];
  const gone = await waitFor(() => pids.every((pid) => !alive(pid)), 3_000);
  assert.equal(await listening(codex.port), false, "no listener after SIGTERM");
  assert.ok(gone, `still alive: ${pids.filter(alive).join(", ")}`);
  const result = await bridge.done;
  assert.ok(Date.now() - sent < 3_000, "the bridge exited within 3 s");
  assert.equal(result.status, 128 + 15, result.stderr);
  // The wrapped command got SIGTERM itself, not the SIGKILL fallback.
  assert.equal(box.codexResult().pid !== undefined, true);
  assert.equal(readFileSync(join(box.dir, "codex-signal"), "utf8"), "SIGTERM");
}));

// Protects the abort of a request still in flight when the wrapped command exits, and that nothing keeps the event
// loop alive: `main` runs without the bin's process.exit, so the process ends only if every handle is closed.
test("a request in flight when the command exits is aborted, and the process ends by itself", TIMEOUT, () => withSandbox({}, async (box) => {
  // The request comes from a helper that outlives the wrapped command and keeps its connection open, so the
  // bridge itself must abort it; the client going away cannot do that job.
  let helper;
  try {
    const result = await runWithoutExit([...EXEC, "codex"], { ...box.env, FAKE_CODEX_MODE: "exit-mid", FAKE_CLAUDE_MODE: "hang" }, { timeoutMs: 30_000 });
    helper = box.codexResult()?.helper;
    assert.equal(result.signal, null, "the process ended by itself, not by the test's kill");
    assert.equal(result.status, 0, result.stderr);
    const events = box.claudeEvents();
    const query = events.find((e) => e.event === "query");
    assert.ok(query, "the request reached the fake claude before the command exited");
    for (const pid of [...events.filter((e) => e.event === "launch").map((e) => e.pid), query.grandchild]) {
      assert.equal(await waitFor(() => !alive(pid), 3_000), true, `pid ${pid} outlived the bridge`);
    }
  } finally {
    if (helper && alive(helper)) process.kill(helper, "SIGKILL");
  }
}));

// Protects the preflight: a missing claude, a missing override and a missing command fail with a named error and a
// hint, before anything listens or starts.
test("missing claude, missing override, missing command fail before listening", TIMEOUT, async () => {
  await withSandbox({ claude: false }, async (box) => {
    const result = await run([...EXEC, "codex"], box.env);
    assert.equal(result.status, 127);
    assert.match(result.stderr, /CODEX_BRIDGE_CLAUDE_NOT_FOUND: .*Install Claude Code/);
    assert.equal(box.codexResult(), undefined);
    assert.equal(existsSync(box.env.CODEX_HOME), false, "nothing was written");
  });
  await withSandbox({}, async (box) => {
    const missing = join(box.dir, "no-such-claude");
    const result = await run([...EXEC, "codex"], { ...box.env, CODEX_BRIDGE_CLAUDE_COMMAND: missing });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /CODEX_BRIDGE_CLAUDE_NOT_FOUND: CODEX_BRIDGE_CLAUDE_COMMAND names/);
    assert.equal(box.codexResult(), undefined);

    const noCommand = await run([...EXEC, "no-such-codex"], box.env);
    assert.equal(noCommand.status, 127);
    assert.match(noCommand.stderr, /CODEX_BRIDGE_COMMAND_NOT_FOUND: .*no-such-codex.*Install it/);
    const empty = await run(EXEC, box.env);
    assert.equal(empty.status, 64);
    assert.match(empty.stderr, /CODEX_BRIDGE_COMMAND_MISSING/);
    assert.deepEqual(box.claudeEvents(), []);
    assert.equal(existsSync(box.env.CODEX_HOME), false, "nothing was written");
  });
});

// Protects the conflicting-credential refusal: named by variable, value never printed, nothing started.
test("a conflicting API key or backend variable is refused by name, value not shown", TIMEOUT, () => withSandbox({}, async (box) => {
  const value = "example-secret-value-do-not-print-0123";
  for (const [name, extra] of [["ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: value }], ["CLAUDE_CODE_USE_BEDROCK", { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_AUTH_TOKEN: value }]]) {
    const result = await run([...EXEC, "codex"], { ...box.env, ...extra });
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, /CODEX_BRIDGE_CONFLICTING_ENV/);
    assert.match(result.stderr, new RegExp(name));
    assert.equal((result.stdout + result.stderr).includes(value), false, "the value was printed");
    assert.equal(box.codexResult(), undefined);
    assert.deepEqual(box.claudeEvents(), []);
  }
}));

// Protects the usage-credit stop: a turn charged to usage credits fails (402, named code) unless the opt-in is set.
test("a usage-credit turn fails without the opt-in and passes with it", TIMEOUT, () => withSandbox({}, async (box) => {
  const env = { ...box.env, FAKE_CODEX_MODE: "one", FAKE_CLAUDE_MODE: "billing" };
  const refused = await run([...EXEC, "codex"], env);
  assert.equal(refused.status, 1, refused.stderr);
  const out = box.codexResult();
  assert.equal(out.one.status, 402);
  assert.match(out.one.body, /CLAUDE_CODE_BILLING/);
  assert.match(refused.stderr, /CODEX_BRIDGE_ALLOW_USAGE_CREDITS=1/);

  const allowed = await run([...EXEC, "codex"], { ...env, CODEX_BRIDGE_ALLOW_USAGE_CREDITS: "1" });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(box.codexResult().one.status, 200);
}));

// Protects the command line: --help and --version print and exit 0 doing nothing else; bad usage exits 64.
test("--help, --version, unknown options", TIMEOUT, () => withSandbox({}, async (box) => {
  const { CODEX_HOME: _, ...noHome } = box.env;
  for (const flag of ["--help", "--version"]) {
    const result = await run([flag], { ...noHome, PATH: "/nonexistent" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, flag === "--help" ? /^usage: codex-on-claude-code exec/ : /^0\.1\.0\n$/);
  }
  for (const args of [["--bogus"], ["exec", "--bogus", "--", "codex"], [], ["exec", "--model"], ["exec", "codex"]]) {
    const result = await run(args, box.env);
    assert.equal(result.status, 64, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /usage: codex-on-claude-code/);
  }
  assert.equal(existsSync(box.env.CODEX_HOME), false);
  assert.deepEqual(box.claudeEvents(), []);
}));

// Protects both CODEX_HOME checks on their own: the early check, and the check at write time that keeps a file
// created or replaced after the early check from being overwritten.
test("checkCodexHome and writeCodexConfig each refuse a foreign config", TIMEOUT, () => withSandbox({}, async (box) => {
  mkdirSync(box.env.CODEX_HOME);
  const config = join(box.env.CODEX_HOME, "config.toml");
  writeFileSync(config, "foreign\n");
  assert.throws(() => checkCodexHome(box.env), { code: "CODEX_BRIDGE_HOME_FOREIGN_CONFIG" });
  assert.throws(() => writeCodexConfig(box.env.CODEX_HOME, `${MARKER}\nnew\n`), { code: "CODEX_BRIDGE_HOME_FOREIGN_CONFIG" });
  assert.equal(readFileSync(config, "utf8"), "foreign\n");
  assert.throws(() => checkCodexHome({ ...box.env, CODEX_HOME: join(box.home, ".codex") }), { code: "CODEX_BRIDGE_HOME_IS_DEFAULT" });
  assert.throws(() => checkCodexHome({ HOME: box.home }), { code: "CODEX_BRIDGE_HOME_UNSET" });
}));

// Invalid JSON shapes must be client errors and must never start a model turn.
test("malformed request objects return 400 without calling the adapter", async () => {
  let calls = 0;
  const token = "a".repeat(64);
  const bridge = await startBridge({ token, adapter: { async *stream() { calls++; } } });
  try {
    for (const body of [null, [], 42, "text", { input: [null] }, { tools: [null] }, { input: [42] }, { tools: ["function"] }]) {
      const response = await fetch(`${bridge.url}/responses`, {
        method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json()).error.message, "expected a request object with object entries in input and tools");
    }
    assert.equal(calls, 0);
  } finally { await bridge.close(); }
});

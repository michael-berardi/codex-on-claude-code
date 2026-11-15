// A stand-in for the Codex CLI: reads CODEX_HOME/config.toml like Codex does, takes the bearer token from the
// variable named by `env_key`, and talks Responses to the bridge. Behaviour comes from FAKE_CODEX_MODE:
//   roundtrip  tool call, then tool result, then final message
//   one        a single request
//   badauth    requests with no token and a wrong token
//   hang       one request, then wait forever (the fake claude should hang too)
//   exit-mid   start a helper process that sends one request and keeps its connection open, then exit 0
//              while that request is still in flight (the helper's pid is saved; the test stops it)
// The outcome is written as JSON to FAKE_CODEX_OUT. This file is test-only; real Codex never sees it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const env = process.env;
const config = readFileSync(join(env.CODEX_HOME, "config.toml"), "utf8");
const baseUrl = /^base_url = "([^"]+)"$/m.exec(config)[1];
const keyName = /^env_key = "([^"]+)"$/m.exec(config)[1];
const model = /^model = "([^"]+)"$/m.exec(config)[1];
const token = env[keyName];
const out = { pid: process.pid, argv: process.argv, keyName, token, baseUrl, port: Number(new URL(baseUrl).port) };
const save = () => writeFileSync(env.FAKE_CODEX_OUT, JSON.stringify(out));

const tools = [
  { type: "function", name: "exec_command", description: "run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
  { type: "web_search" },
  { type: "namespace", name: "multi_agent_v1", tools: [] },
];
const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

async function post(input, authorization = `Bearer ${token}`) {
  const headers = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST", headers,
    body: JSON.stringify({ model, instructions: "be brief", input, tools, stream: true, prompt_cache_key: "s1" }),
  });
  const text = await response.text();
  const events = response.status === 200
    ? text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data: ")).slice(6)))
    : [];
  return { status: response.status, body: response.status === 200 ? undefined : text, completed: events.find((e) => e.type === "response.completed")?.response };
}

const mode = env.FAKE_CODEX_MODE ?? "one";
if (mode === "roundtrip") {
  const first = await post([user("list files")]);
  out.first = first;
  const call = first.completed.output.find((i) => i.type === "function_call");
  const second = await post([user("list files"), ...first.completed.output, { type: "function_call_output", call_id: call.call_id, output: "a.py" }]);
  out.second = second;
  save();
  process.exit(second.status === 200 ? 0 : 1);
} else if (mode === "badauth") {
  out.missing = (await post([user("hi")], null)).status;
  out.wrong = (await post([user("hi")], `Bearer ${"0".repeat(64)}`)).status;
  save();
  process.exit(0);
} else if (mode === "hang") {
  if (!env.FAKE_CODEX_HELPER) {
    // A process of our own, like a tool command Codex runs: it must be stopped with the whole group.
    const { spawn } = await import("node:child_process");
    out.grandchild = spawn("sleep", ["300"], { stdio: "ignore" }).pid;
    save();
    // Record which signal stopped us, so the test can tell SIGTERM from the SIGKILL fallback.
    process.once("SIGTERM", () => { writeFileSync(join(dirname(env.FAKE_CODEX_OUT), "codex-signal"), "SIGTERM"); process.exit(143); });
  }
  post([user("hi")]).catch(() => {});
  setInterval(() => {}, 1 << 30);
} else if (mode === "exit-mid") {
  const { spawn } = await import("node:child_process");
  const helper = spawn(process.execPath, [process.argv[1]], { stdio: "ignore", env: { ...env, FAKE_CODEX_MODE: "hang", FAKE_CODEX_HELPER: "1" } });
  out.helper = helper.pid;
  save();
  setTimeout(() => process.exit(0), Number(env.FAKE_CODEX_DELAY_MS ?? 1500));
} else {
  const one = await post([user("hi")]);
  out.one = one;
  save();
  process.exit(one.status === 200 ? 0 : 1);
}

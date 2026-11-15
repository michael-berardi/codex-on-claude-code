// A stand-in for the Claude Code CLI: enough of its stream-json protocol to drive the claude-code module.
// Behaviour comes from FAKE_CLAUDE_MODE (comma list: text, tool-then-text, thinking, billing, hang).
// Every launch and query is appended to FAKE_CLAUDE_LOG as one JSON line.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;
const modes = new Set((env.FAKE_CLAUDE_MODE ?? "text").split(",").filter(Boolean));
const record = (entry) => { if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

if (args[0] === "auth" && args[1] === "status") {
  record({ event: "auth-status" });
  emit({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
  process.exit(0);
}

const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
record({ event: "launch", model: flag("--model"), argv: args, tokenEnvSet: "CODEX_BRIDGE_TOKEN" in env, apiKeySet: Boolean(env.ANTHROPIC_API_KEY) });

const frames = [];

function nativeMessage() {
  const afterToolResult = frames.at(-1)?.message?.content?.some?.((b) => b.type === "tool_result");
  if (modes.has("tool-then-text") && afterToolResult) {
    return { id: "msg_done", role: "assistant", content: [{ type: "text", text: env.FAKE_CLAUDE_TEXT ?? "done" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 } };
  }
  const useTool = modes.has("tool-then-text");
  const content = [];
  if (modes.has("thinking")) content.push({ type: "thinking", thinking: "pondering", signature: "sig-1" });
  content.push({ type: "text", text: env.FAKE_CLAUDE_TEXT ?? "fake reply" });
  if (useTool) content.push({ type: "tool_use", id: "toolu_1", name: `mcp__codex__${env.FAKE_CLAUDE_TOOL ?? "exec_command"}`, input: JSON.parse(env.FAKE_CLAUDE_TOOL_INPUT ?? "{}") });
  return {
    id: "msg_fake", role: "assistant", content,
    stop_reason: useTool ? "tool_use" : "end_turn",
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
  };
}

function directStream(message) {
  emit({ type: "stream_event", event: { type: "message_start", message: { ...message, content: [] } } });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } });
    } else if (block.type === "thinking") {
      emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } });
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } } });
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } } });
    } else {
      emit({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } });
      emit({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } } });
    }
    emit({ type: "stream_event", event: { type: "content_block_stop", index } });
  });
  emit({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage } });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  emit({ type: "assistant", message });
}

async function answer() {
  if (modes.has("hang")) {
    const child = spawn("sleep", ["300"], { stdio: "ignore" });
    record({ event: "query", grandchild: child.pid });
    return new Promise(() => {});
  }
  record({ event: "query", blocks: frames.at(-1)?.message?.content?.map?.((b) => b.type) ?? [] });
  const message = nativeMessage();
  directStream(message);
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", isUsingOverage: modes.has("billing") } });
  emit({ type: "result", subtype: message.stop_reason === "tool_use" ? "error_max_turns" : "success", is_error: false, num_turns: 1, usage: message.usage });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { models: [] } } });
    continue;
  }
  frames.push(frame);
  if (frame.type !== "user") continue; // assistant frames are history
  if (frame.shouldQuery === false) { emit({ type: "result", subtype: "success", is_error: false, num_turns: 0 }); continue; }
  await answer();
}
process.exit(0);

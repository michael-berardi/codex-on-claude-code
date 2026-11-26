// Privacy regression: no analytics/telemetry SDK or endpoint may enter shipped source, and the generated
// Codex config must stay on loopback. The telemetry-off environment is asserted in bridge.test.js through
// the fake Codex CLI, so the check covers the actual launch path.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { configToml, startBridge } from "../codex-bridge/bridge.mjs";
import { TELEMETRY_OFF_ENV, withTelemetryOff } from "../claude-code/env.js";
import { discoveryEnvironment } from "../claude-code/claude-cli.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  "bin/codex-on-claude-code",
  "package.json",
  ...readdirSync(join(root, "codex-bridge")).filter((name) => /\.(?:js|mjs)$/u.test(name)).map((name) => `codex-bridge/${name}`),
  ...readdirSync(join(root, "claude-code")).filter((name) => /\.(?:js|mjs)$/u.test(name)).map((name) => `claude-code/${name}`),
];

// Known analytics/crash-reporting vendors and exporters. None is used by this project.
const TELEMETRY = /\b(?:posthog|sentry|segment\.io|segment\.com|mixpanel|amplitude|datadog|bugsnag|google[-_]?analytics|gtag|opentelemetry|otel|otlp)\b/iu;

test("shipped source and package.json contain no telemetry vendor, SDK or endpoint", () => {
  for (const file of sourceFiles) {
    const text = readFileSync(join(root, file), "utf8");
    assert.equal(TELEMETRY.test(text), false, `telemetry reference in ${file}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(pkg[key] ?? {}, {}, `unexpected ${key}`);
  }
});

test("the bridge listens on loopback and its generated config has only that URL", async () => {
  const bridge = await startBridge({ adapter: { stream: async function* () {} }, token: "a".repeat(64) });
  try {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    const config = configToml({ url: bridge.url, model: "default" });
    assert.equal((config.match(/https?:\/\//gu) ?? []).length, 1, "config contains only the loopback URL");
    assert.match(config, /^base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"$/mu);
    assert.equal(TELEMETRY.test(config), false);
  } finally {
    await bridge.close();
  }
});

test("the telemetry opt-out forces a quiet environment for launched commands", () => {
  assert.deepEqual(withTelemetryOff({ DO_NOT_TRACK: "0", CODEX_HOME: "/private" }), {
    DO_NOT_TRACK: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CODEX_HOME: "/private",
  });
  for (const [key, value] of Object.entries(TELEMETRY_OFF_ENV)) assert.equal(value, "1");
});

test("the model-catalog probe keeps every telemetry switch on, like each request", () => {
  const env = discoveryEnvironment({ DO_NOT_TRACK: "0", DISABLE_TELEMETRY: "0" });
  for (const key of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DO_NOT_TRACK"]) {
    assert.equal(env[key], "1", key);
  }
});

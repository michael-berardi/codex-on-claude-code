// Privacy regression: no analytics/telemetry SDK or endpoint may enter shipped source, and the generated
// Codex config must stay on loopback. The telemetry-off environment is asserted in bridge.test.js through
// the fake Codex CLI, so the check covers the actual launch path.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { configToml, startBridge } from "../codex-bridge/bridge.mjs";
import { TELEMETRY_OFF_ENV, withTelemetryOff } from "../claude-code/env.js";
import { discoveryEnvironment } from "../claude-code/claude-cli.js";
import { run, sandbox, start, waitFor } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXEC = ["exec", "--model", "default", "--"];
const TEMP_PREFIX = "codex-bridge-claude-code-";

/** The private folder a launched fake `claude` was given for system.md, tools.json and settings.json. */
function perTurnRoot(events) {
  const launch = events.find((event) => event.event === "launch");
  assert.ok(launch, "Claude Code was launched");
  const systemPath = launch.argv[launch.argv.indexOf("--system-prompt-file") + 1];
  assert.ok(systemPath, "the CLI was given a system prompt file");
  return dirname(systemPath);
}
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

// Protects the short README privacy section: at most six lines there, the details in PRIVACY.md, and the
// update check described truthfully (anonymous, daily, with its opt-out) in both places.
test("README privacy stays short; PRIVACY.md holds the details", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const section = /^## Privacy\n([\s\S]*?)(?=^## )/mu.exec(readme)?.[1] ?? "";
  const lines = section.split("\n").filter((line) => line.trim());
  assert.ok(lines.length >= 3 && lines.length <= 6, `README privacy section has ${lines.length} non-empty lines`);
  assert.match(section, /\[PRIVACY\.md\]\(PRIVACY\.md\)/u);
  assert.match(section, /No telemetry/u);
  assert.match(section, /CODEX_ON_CLAUDE_CODE_NO_UPDATE_CHECK=1/u);

  const privacy = readFileSync(join(root, "PRIVACY.md"), "utf8");
  for (const detail of [
    "127.0.0.1", "CODEX_BRIDGE_TOKEN", "model-catalog-probe", "DO_NOT_TRACK=1", "CLAUDE_CODE_BILLING",
    "User-Agent: codex-on-claude-code-update-check", "CODEX_ON_CLAUDE_CODE_NO_UPDATE_CHECK=1", "update --checks off",
    "$CODEX_HOME/config.toml", "codex-bridge-claude-code-", "update.json", "update.log", "256 KB", "update --auto off",
  ]) assert.ok(privacy.includes(detail), `PRIVACY.md names ${detail}`);
  for (const text of [readme, privacy]) assert.doesNotMatch(text, /no (?:runtime )?update check/iu);
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

// Protects PRIVACY.md's local-write table: every per-turn file and the atomic config temp file must be gone when
// a run ends, including when the config is replaced on a later run with the same CODEX_HOME.
test("per-turn files and the config temp file are removed after successful runs", { timeout: 120_000 }, async () => {
  const box = sandbox();
  try {
    const tmp = join(box.dir, "tmp");
    mkdirSync(tmp, { mode: 0o700 });
    const env = { ...box.env, TMPDIR: tmp };
    const first = await run([...EXEC, "codex"], env);
    assert.equal(first.status, 0, first.stderr);
    const privateRoot = perTurnRoot(box.claudeEvents());
    assert.ok(privateRoot.startsWith(join(tmp, TEMP_PREFIX)), "the CLI used the private temp folder");
    assert.equal(existsSync(privateRoot), false, "per-turn folder removed at process exit");
    assert.deepEqual(readdirSync(tmp), [], "no per-turn folder remains in TMPDIR");
    assert.deepEqual(readdirSync(box.env.CODEX_HOME), ["config.toml"], "no config temp file remains");

    const second = await run([...EXEC, "codex"], env);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readdirSync(tmp), [], "the second run left no per-turn folder");
    assert.deepEqual(readdirSync(box.env.CODEX_HOME), ["config.toml"], "the replaced config left no temp file");
  } finally {
    box.cleanup();
  }
});

// Protects the same guarantee on the interrupted path: a live turn has all three files, and SIGTERM must remove
// all of them before the bridge exits. Without teardown, this test finds the folder still on disk.
test("per-turn files are removed when a live run is stopped by SIGTERM", { timeout: 120_000 }, async () => {
  const box = sandbox();
  try {
    const tmp = join(box.dir, "tmp");
    mkdirSync(tmp, { mode: 0o700 });
    const bridge = start([...EXEC, "codex"], {
      ...box.env, TMPDIR: tmp, FAKE_CODEX_MODE: "hang", FAKE_CLAUDE_MODE: "hang",
    });
    const query = await waitFor(() => box.claudeEvents().find((event) => event.event === "query"), 60_000);
    assert.ok(query, "the request reached the fake claude");
    const privateRoot = perTurnRoot(box.claudeEvents());
    assert.ok(privateRoot.startsWith(join(tmp, TEMP_PREFIX)), "the CLI used the private temp folder");
    assert.deepEqual(readdirSync(privateRoot).sort(), ["settings.json", "system.md", "tools.json"]);
    bridge.child.kill("SIGTERM");
    const result = await bridge.done;
    assert.equal(result.status, 128 + 15, result.stderr);
    assert.equal(existsSync(privateRoot), false, "per-turn folder removed after SIGTERM");
    assert.deepEqual(readdirSync(tmp), [], "no per-turn folder remains in TMPDIR");
  } finally {
    box.cleanup();
  }
});

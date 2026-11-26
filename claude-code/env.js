/** Whether an environment flag is set to something other than an explicit "off" value. */
export function envFlagEnabled(value ) {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && !["0", "false", "no", "off"].includes(normalized);
}

/** Telemetry opt-outs for subprocesses this tool launches. None of them change model routing or credentials. */
export const TELEMETRY_OFF_ENV = Object.freeze({
  DO_NOT_TRACK: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
});

/** Force the opt-outs on for a child environment, whatever the caller had set. */
export function withTelemetryOff(env) {
  return { ...env, ...TELEMETRY_OFF_ENV };
}

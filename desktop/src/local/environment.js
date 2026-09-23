// A downloaded local app must not silently pick up cloud credentials or
// reporting endpoints from the shell that launched it. Keep only OS settings
// needed by its bundled processes; all product configuration is explicit.
function localEnvironment(overrides = {}, inherited = process.env) {
  const env = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "SYSTEMROOT"]) {
    if (typeof inherited[key] === "string") env[key] = inherited[key];
  }
  return {
    ...env,
    DOTENV_CONFIG_PATH: "/dev/null",
    SENTRY_DISABLED: "true",
    NEXT_PUBLIC_SENTRY_DISABLED: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    ...overrides,
  };
}

module.exports = { localEnvironment };

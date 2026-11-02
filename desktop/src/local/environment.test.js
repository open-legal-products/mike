const test = require("node:test");
const assert = require("node:assert/strict");
const { localEnvironment } = require("./environment");

test("local services cannot inherit cloud keys, debug logging, or telemetry from the launcher", () => {
  const env = localEnvironment({ SUPABASE_SECRET_KEY: "per-install", API_BASE_URL: "http://localhost:42814" }, {
    HOME: "/Users/example", PATH: "/usr/bin", TMPDIR: "/tmp",
    OPENAI_API_KEY: "cloud-secret", SENTRY_DSN: "https://cloud.example",
    SUPABASE_SECRET_KEY: "cloud-db", OLLAMA_BASE_URL: "https://external.example",
    LOG_RAW_LLM_STREAM: "true", NODE_OPTIONS: "--require=/untrusted.js",
    HTTP_PROXY: "http://proxy.example", DOTENV_CONFIG_PATH: "/cloud/.env",
  });
  assert.equal(env.HOME, "/Users/example");
  assert.equal(env.SUPABASE_SECRET_KEY, "per-install");
  assert.equal(env.DOTENV_CONFIG_PATH, "/dev/null");
  assert.equal(env.SENTRY_DISABLED, "true");
  assert.equal(env.NEXT_PUBLIC_SENTRY_DISABLED, "true");
  for (const key of ["OPENAI_API_KEY", "SENTRY_DSN", "OLLAMA_BASE_URL", "LOG_RAW_LLM_STREAM", "NODE_OPTIONS", "HTTP_PROXY"]) {
    assert.equal(env[key], undefined);
  }
});

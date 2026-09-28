// Opt-in smoke test: downloads the approved starter model into disposable test
// userData, runs synthetic inference/tool checks, then stops its owned runtime.
// The model cache is retained so the desktop UI test can reuse the download.
// Run after local:fetch; never run concurrently with another local model test.
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import managerModule from "../src/local/model-manager.js";
import catalog from "../src/local/model-catalog.js";

const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts");
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--model=4b"),
  "Usage: node desktop/e2e/model-smoke.mjs [--model=4b]");
const modelOverride = args[0] === "--model=4b" ? catalog.MODEL : null;
const userData = path.join(artifacts, modelOverride ? "model-4b-userdata" : "model-userdata");
await mkdir(userData, { recursive: true });
if (modelOverride) {
  // Exercise a reviewed alternative on actual hardware without falsifying the
  // RAM measurement or changing the production starter-model recommendation.
  const local = path.join(userData, "local");
  await mkdir(local, { recursive: true });
  const selected = path.join(local, "local-model.json");
  try { await access(selected); }
  catch { await writeFile(selected, JSON.stringify({ version: 1, modelId: modelOverride.id,
    manifestDigest: null, benchmark: null }), { mode: 0o600 }); }
}
const app = { isPackaged: false, getPath: (name) => {
  assert.equal(name, "userData");
  return userData;
} };
let lastProgress;
const manager = managerModule.createModelManager(app, { onStatus: (state) => {
  const marker = `${state.state}:${Math.floor(state.progress * 10)}`;
  if (marker === lastProgress) return;
  lastProgress = marker;
  console.log(`${state.modelName}: ${state.state}${state.state === "downloading" ? ` ${Math.round(state.progress * 100)}%` : ""}`);
} });
let stopping = false;
async function stopForSignal() {
  if (stopping) return;
  stopping = true;
  await manager.stop();
  process.exitCode = 130;
}
process.once("SIGINT", stopForSignal);
process.once("SIGTERM", stopForSignal);

try {
  const state = await manager.install();
  assert.equal(state.state, "ready", state.error || "Model did not become ready");
  const measured = await manager.benchmark();
  assert.equal(measured.state, "ready", measured.error || "Performance check failed");
  assert.equal(measured.benchmark?.passed, true, "The synthetic extraction check returned incorrect facts");
  console.log(`Synthetic extraction: ${measured.benchmark.checks.filter((check) => check.passed).length}/3; ${measured.benchmark.latencyMs} ms; ${measured.benchmark.tokensPerSecond ?? "unavailable"} tokens/s`);

  const started = performance.now();
  const response = await fetch(`${catalog.OLLAMA_URL}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: state.modelId.replace(/^ollama\//, ""), stream: false,
      reasoning_effort: "none", temperature: 0, max_tokens: 128,
      messages: [
        { role: "system", content: "Extract the requested facts by calling record_contract. Use the tool instead of answering in prose." },
        { role: "user", content: "This fabricated contract has reference MIKE-42, effective date 15 January 2026, and fixed fee USD 7,500. Record its reference, date in YYYY-MM-DD format, and numeric amount." },
      ],
      tools: [{ type: "function", function: { name: "record_contract",
        description: "Record the contract facts requested by the user.",
        parameters: { type: "object", properties: { reference: { type: "string" },
          date: { type: "string" }, amount: { type: "number" } },
        required: ["reference", "date", "amount"], additionalProperties: false } } }],
    }),
  });
  assert.equal(response.ok, true, `Tool request failed with status ${response.status}`);
  const result = await response.json();
  const calls = result.choices?.[0]?.message?.tool_calls;
  assert.equal(calls?.length, 1, "Expected one structured tool call");
  assert.equal(calls[0].function?.name, "record_contract");
  const args = JSON.parse(calls[0].function.arguments);
  assert.deepEqual(args, { reference: "MIKE-42", date: "2026-01-15", amount: 7500 });
  const toolLatencyMs = Math.round(performance.now() - started);
  console.log(`OpenAI-compatible tool call: correct function and 3/3 arguments; ${toolLatencyMs} ms`);
  await writeFile(path.join(artifacts, modelOverride ? "model-4b-smoke.json" : "model-smoke.json"), JSON.stringify({
    modelId: state.modelId, hardware: state.hardware, benchmark: measured.benchmark,
    toolCall: { passed: true, latencyMs: toolLatencyMs }, recordedAt: new Date().toISOString(),
  }, null, 2) + "\n");
} catch (error) {
  // Assertions use controlled messages and synthetic values only.
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await manager.stop();
  process.removeListener("SIGINT", stopForSignal);
  process.removeListener("SIGTERM", stopForSignal);
  console.log("Owned model runtime stopped; disposable model cache retained.");
}

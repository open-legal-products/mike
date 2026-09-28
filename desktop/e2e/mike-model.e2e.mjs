// Opt-in real Mike + managed model smoke test. Reuses ONLY the disposable
// e2e/artifacts/model-userdata (or model-4b-userdata) populated by model-smoke.mjs.
// Never run alongside another local-stack/model test. No paid provider keys,
// model download, or real documents are used here.
//
// Packaged: node desktop/e2e/mike-model.e2e.mjs (after dist:local)
// Reviewed 4B comparison: node desktop/e2e/mike-model.e2e.mjs --model=4b
// Fresh first-use account/database: add --fresh (clones only pinned model files).
// Source:   MIKE_E2E_DEV=1 node desktop/e2e/mike-model.e2e.mjs (after local:build)
// This checks two synthetic tasks, not legal quality or production throughput.
import assert from "node:assert/strict";
import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { dismissFirstRunOverlay, packagedAppBinary } from "./helpers.mjs";
import catalog from "../src/local/model-catalog.js";

const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(desktop, "e2e", "artifacts");
const args = process.argv.slice(2);
assert.ok(args.every((arg) => ["--model=2b", "--model=4b", "--fresh"].includes(arg))
  && new Set(args).size === args.length && args.filter((arg) => arg.startsWith("--model=")).length <= 1,
  "Usage: node desktop/e2e/mike-model.e2e.mjs [--model=2b|--model=4b] [--fresh]");
const expected = args.includes("--model=4b") ? catalog.MODEL
  : args.includes("--model=2b") ? catalog.SMALL_MODEL : catalog.chooseStarterModel(os.totalmem());
const modelLabel = expected.tag.split(":")[1];
const fresh = args.includes("--fresh");
const cachedUserData = path.join(artifacts, args.includes("--model=4b") ? "model-4b-userdata" : "model-userdata");
const reportDir = path.join(artifacts, "mike-model-runs", `${modelLabel}${fresh ? "-fresh" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const userData = fresh ? path.join(reportDir, "userdata") : cachedUserData;
const origin = "http://localhost:42815";
const dev = process.env.MIKE_E2E_DEV === "1";
const cdpPort = 9226;
const turnTimeoutMs = 180_000;
const summary = {
  recordedAt: new Date().toISOString(),
  mode: dev ? "source" : "packaged",
  fresh,
  modelId: expected.id,
  contextLength: Math.min(expected.contextLength, os.totalmem() < 16 * 1024 ** 3 ? 8192 : 16384),
  memoryBytes: os.totalmem(),
  ok: false,
  blockedExternalOrigins: [],
  qualityNotes: [],
  reportDir,
  turns: [],
  requests: [],
};

async function clonePinnedModel() {
  const cachedLocal = path.join(cachedUserData, "local");
  const local = path.join(userData, "local");
  const state = JSON.parse(await readFile(path.join(cachedLocal, "local-model.json"), "utf8"));
  assert.equal(state.modelId, expected.id, "Cached model selection does not match this comparison");
  assert.equal(state.manifestDigest, expected.digest, "Cached model is not verified against the approved pin");
  const files = [
    ...expected.layers.map((layer) => path.join("models", "blobs", `sha256-${layer.digest}`)),
    path.join("models", "manifests", "registry.ollama.ai", "library", "qwen3.5", modelLabel),
  ];
  for (const relative of files) {
    const source = path.join(cachedLocal, relative);
    assert.ok((await lstat(source)).isFile(), "Pinned cache entries must be regular files");
    const destination = path.join(local, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
  }
  // No database, credentials, cookies, profiles or queued jobs are copied.
  await writeFile(path.join(local, "local-model.json"), JSON.stringify({
    version: 1, modelId: expected.id, manifestDigest: expected.digest, benchmark: null,
  }) + "\n", { mode: 0o600 });
}

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds / 1000}s`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function readSse(body) {
  const events = [];
  let done = false;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") done = true;
    else if (data) events.push(JSON.parse(data));
  }
  return {
    events,
    done,
    answer: events.filter((event) => event.type === "content_delta").map((event) => event.text ?? "").join(""),
    // Facts mentioned before the last tool call do not establish that the
    // assistant completed a tool-backed task. Score only its later answer.
    finalAnswer: events.slice(events.findLastIndex((event) => event.type === "tool_call_start") + 1)
      .filter((event) => event.type === "content_delta").map((event) => event.text ?? "").join(""),
    tools: events.filter((event) => event.type === "tool_call_start").map((event) => event.name),
  };
}

let app;
let page;
let closing;
const rendererErrors = [];
const blockedOrigins = new Set();
async function closeApp() {
  if (app && !closing) closing = app.close(); // Runs the real before-quit supervisor shutdown.
  if (closing) await closing;
}
const onSignal = () => {
  process.exitCode = 130;
  void closeApp();
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

async function sendThroughComposer(label, prompt) {
  await page.waitForURL((url) => url.pathname === "/assistant" && !url.search, { timeout: 15_000 });
  const composer = page.getByRole("combobox", { name: "How can I help?" });
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  const started = performance.now();
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST",
  { timeout: turnTimeoutMs });
  await composer.fill(prompt);
  await composer.press("Enter");
  const response = await responsePromise;
  assert.equal(response.status(), 200, `${label}: Mike chat returned HTTP ${response.status()}`);
  assert.match(response.headers()["content-type"] ?? "", /text\/event-stream/, `${label}: expected real Mike SSE`);
  const request = response.request().postDataJSON();
  const requestMetadata = { label, model: request.model, chatId: request.chat_id,
    messageCount: request.messages?.length, roles: request.messages?.map((message) => message.role) };
  summary.requests.push(requestMetadata);
  assert.equal(request.model, expected.id, `${label}: composer did not use the local default`);
  assert.deepEqual(requestMetadata.roles, ["user"], `${label}: expected one independent user turn without history`);
  assert.equal(request.messages[0].content, prompt, `${label}: user prompt changed`);
  const body = await bounded(response.text(), turnTimeoutMs, `${label} response`);
  const responseArtifact = `mike-model-turn-${summary.turns.length + 1}.sse.txt`;
  await writeFile(path.join(reportDir, responseArtifact), body);
  const parsed = readSse(body);
  const chatId = parsed.events.find((event) => event.type === "chat_id")?.chatId;
  assert.equal(typeof chatId, "string", `${label}: missing chat identity`);
  assert.ok(!summary.turns.some((turn) => turn.chatId === chatId), `${label}: reused an earlier conversation`);
  const result = {
    label,
    chatId,
    responseArtifact,
    latencyMs: Math.round(performance.now() - started),
    answer: parsed.answer,
    finalAnswer: parsed.finalAnswer,
    toolNames: parsed.tools,
    eventTypes: [...new Set(parsed.events.map((event) => event.type))],
    completed: parsed.done,
    errors: parsed.events.filter((event) => event.type === "error"),
  };
  summary.turns.push(result);
  assert.equal(parsed.done, true, `${label}: stream ended without [DONE]`);
  assert.equal(result.errors.length, 0, `${label}: Mike emitted an error event`);
  if (parsed.answer.trim()) {
    const answerElement = page.locator("div.prose.font-serif.text-gray-900").last();
    await answerElement.waitFor({ state: "visible", timeout: 10_000 });
  }
  if (!parsed.tools.includes("ask_inputs")) {
    await page.getByRole("button", { name: "Stop response", exact: true }).waitFor({ state: "hidden", timeout: 10_000 });
  }
  console.log(`${label}: ${result.latencyMs}ms; ${parsed.tools.length} tool call(s)`);
  return parsed;
}

try {
  await mkdir(reportDir, { recursive: true });
  if (fresh) await clonePinnedModel();
  assert.ok(existsSync(path.join(userData, "local", "local-model.json")),
    "No disposable installed model: run desktop/e2e/model-smoke.mjs first");
  for (const port of [cdpPort, 42810, 42811, 42812, 42813, 42814, 42815, 42816]) {
    assert.equal(await portAvailable(port), true, `Port ${port} is occupied; stop the other local test before continuing`);
  }
  const bootStarted = performance.now();
  app = await _electron.launch({
    executablePath: dev ? require("electron") : packagedAppBinary(desktop),
    args: [...(dev ? [desktop] : []), "--local", `--remote-debugging-port=${cdpPort}`],
    cwd: desktop,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      MIKE_SERVER_URL: "",
      MIKE_USER_DATA_DIR: userData,
      MIKE_DOWNLOAD_DIR: path.join(artifacts, "model-downloads"),
      MIKE_E2E_CAPTURE_EXTERNAL: path.join(artifacts, "mike-model-external-urls.txt"),
    },
    timeout: 30_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await app.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol)
      && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      blockedOrigins.add(url.origin);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await page.waitForURL((url) => url.origin === origin, { timeout: 180_000 });
  summary.bootMs = Math.round(performance.now() - bootStarted);
  console.log(`Local stack boot: ${summary.bootMs}ms`);

  // Reuse the synthetic account on subsequent runs, but always prove the
  // real local sign-in button and cookie-session path again.
  if (!new URL(page.url()).pathname.startsWith("/login")) {
    await page.evaluate(async () => {
      const response = await fetch("/api/auth/logout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "local" }),
      });
      if (!response.ok) throw new Error("Synthetic account logout failed");
    });
    await page.goto(`${origin}/login`);
  }
  await page.getByRole("button", { name: "Continue on this Mac", exact: true }).click();
  await page.waitForURL(/\/assistant/, { timeout: 45_000 });
  await dismissFirstRunOverlay(page);
  await page.waitForFunction(async (model) => {
    const response = await fetch("/api/user/profile");
    if (!response.ok) return false;
    const profile = await response.json();
    return profile.lastSelectedChatModel === model && profile.legalResearchUs === false;
  }, expected.id, { timeout: 30_000 });
  assert.equal(await page.evaluate(() => window.mikeDesktop.readyLocalModel()), expected.id);
  summary.defaultSelected = true;
  summary.externalResearchEnabled = false;
  console.log(`Default selected automatically: ${expected.id}; external research off`);
  await page.screenshot({ path: path.join(reportDir, "mike-model-01-ready.png") });

  const extractionPrompt = [
    "Use only the following fabricated contract facts. Answer with exactly three short lines: Reference, Date (YYYY-MM-DD), Amount (USD).",
    "The contract reference is MIKE-42. Its effective date is 15 January 2026. Its fixed fee is USD 7,500.",
    "Extract the three facts directly from this message; no document, research, or follow-up questions are needed.",
  ].join("\n");
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const extraction = await sendThroughComposer(`Synthetic extraction through Mike (${attempt}/2)`, extractionPrompt);
    const result = summary.turns.at(-1);
    result.facts = {
      reference: /\bMIKE-42\b/i.test(extraction.finalAnswer),
      date: /\b2026-01-15\b/.test(extraction.finalAnswer),
      amount: /\b7,?500(?:\.00)?\b/.test(extraction.finalAnswer),
    };
    const lines = extraction.finalAnswer.trim().split(/\n+/).map((line) => line.replace(/^[\s*#>\-]+|\*+/g, "").trim());
    result.followedThreeLineFormat = lines.length === 3
      && /^Reference\b/i.test(lines[0]) && /^Date\b/i.test(lines[1]) && /^Amount\b/i.test(lines[2]);
    result.noUnnecessaryTools = extraction.tools.length === 0;
    result.qualityPassed = Object.values(result.facts).every(Boolean)
      && result.followedThreeLineFormat && result.noUnnecessaryTools;
    if (!result.qualityPassed) summary.qualityNotes.push(`Extraction ${attempt} did not complete all three facts in the requested three-line format without unnecessary tools.`);
    await page.screenshot({ path: path.join(reportDir, `mike-model-02-extraction-${attempt}.png`) });
    // Keep every task independent, including any unnecessary clarification.
    await page.getByRole("button", { name: "New chat", exact: true }).click();
  }

  // list_workflows has no filter. It lists only owned/shared assistant
  // workflows; the bundled add-on catalog is explicitly marked unlisted by
  // buildWorkflowStore. Confirm this account is still small before testing.
  const titles = await page.evaluate(async () => {
    const response = await fetch("/api/workflows?type=assistant");
    if (!response.ok) throw new Error("Could not load the synthetic account's workflows");
    const workflows = await response.json();
    if (!Array.isArray(workflows)) throw new Error("Unexpected workflow-list response");
    return workflows.map((workflow) => workflow.metadata?.title ?? workflow.title).filter((title) => typeof title === "string");
  });
  assert.ok(titles.length > 0 && titles.length <= 10,
    "The disposable account must have 1–10 assistant workflows for this bounded tool smoke test");
  summary.availableWorkflowCount = titles.length;
  const listing = await sendThroughComposer("Workflow listing through Mike", [
    "Check which workflows are available in my workspace using the available workflow listing capability.",
    "Then return only the titles of three available workflows. Do not run, read, edit, create, or modify any workflow or document.",
  ].join("\n"));
  const mentionedTitles = titles.filter((title) => listing.finalAnswer.toLowerCase().includes(title.toLowerCase()));
  const listingResult = summary.turns.at(-1);
  listingResult.recognizedWorkflowTitles = mentionedTitles;
  listingResult.onlyRequestedTool = listing.tools.length === 1 && listing.tools[0] === "list_workflows";
  // The request asks for only three titles, not a particular list layout.
  // Accept lines or comma/semicolon-separated titles, with optional bullets,
  // numbering and emphasis; reject preambles, extra titles and other prose.
  let remainder = listing.finalAnswer.replace(/(^|[\n,;])\s*(?:[-*•]|\d+[.)])\s*/g, "$1");
  let titleOccurrences = 0;
  for (const title of titles) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    remainder = remainder.replace(new RegExp(escaped, "gi"), () => { titleOccurrences += 1; return ""; });
  }
  listingResult.onlyThreeWorkflowTitles = titleOccurrences === 3
    && !remainder.replace(/[\s,;.*_•-]/g, "");
  listingResult.qualityPassed = listingResult.onlyRequestedTool && listingResult.onlyThreeWorkflowTitles
    && mentionedTitles.length === 3;
  if (!listingResult.qualityPassed) summary.qualityNotes.push("Workflow listing did not call only list_workflows once and then return exactly three genuine titles.");
  await page.screenshot({ path: path.join(reportDir, "mike-model-03-tools.png") });
  summary.blockedExternalOrigins = [...blockedOrigins];
  summary.rendererErrors = rendererErrors;
  assert.equal(rendererErrors.length, 0, "The local app renderer raised an error");
  for (const note of summary.qualityNotes) console.log(`QUALITY FAILURE: ${note}`);
  assert.equal(summary.qualityNotes.length, 0, "One or more synthetic tasks failed the strict completion checks");
  summary.ok = true;
  console.log("PASS: real Mike local sign-in/default, two exact three-fact extractions, and completed workflow tool roundtrip");
} catch (error) {
  summary.error = error.message;
  summary.rendererErrors = rendererErrors;
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(reportDir, "mike-model-99-failure.png") }).catch(() => {});
  }
} finally {
  await closeApp();
  summary.blockedExternalOrigins = [...blockedOrigins];
  await writeFile(path.join(reportDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  await writeFile(path.join(artifacts, `mike-model-${modelLabel}-summary.json`), JSON.stringify(summary, null, 2) + "\n");
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  console.log("Electron closed through app.quit; disposable model cache retained.");
}

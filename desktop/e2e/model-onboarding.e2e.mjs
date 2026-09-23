// Real Electron pages, preload, IPC authorization and UI; fake model/runtime
// installed by a test-only main entry point before production main.js loads.
// No GPU, model download, local-stack binaries, or real user data required.
// Run: node desktop/e2e/model-onboarding.e2e.mjs (after npm ci --prefix desktop).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, "artifacts");
await mkdir(artifacts, { recursive: true });
const userData = await mkdtemp(path.join(os.tmpdir(), "mike-model-onboarding-"));
const testDirectories = [userData];
let app;
try {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [path.join(here, "fixtures/model-onboarding-main.cjs")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MIKE_USER_DATA_DIR: userData,
      MIKE_SERVER_URL: "", MIKE_E2E_CAPTURE_EXTERNAL: path.join(userData, "external-urls.txt"),
      MIKE_DOWNLOAD_DIR: path.join(userData, "downloads") },
    timeout: 30000,
  });
  let page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const counts = () => app.evaluate(() => globalThis.__modelHarness.counts());
  const waitState = (label) => page.waitForFunction((text) => document.querySelector("#state")?.textContent === text, label);
  const openManager = () => app.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0].loadFile(globalThis.__modelHarness.modelPage);
  });

  await page.getByRole("heading", { name: "Welcome to Mike" }).waitFor();
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items
    .flatMap((item) => item.submenu?.items || []).some((item) => item.label === "Local AI…")), true,
  "the complete app must offer its Local AI menu");
  assert.equal((await counts()).install, 0, "launch must not download a model");
  await page.getByRole("button", { name: /Start on this Mac/ }).click();
  await waitState("Not downloaded");
  assert.equal((await counts()).install, 0, "opening local AI must not download a model");
  assert.equal(await page.locator("#model-heading").textContent(), "Qwen 3.5 2B");
  assert.match(await page.locator("#model-detail").textContent(), /2\.7 GB optional download/);

  await page.getByRole("button", { name: "Download local AI · 2.7 GB" }).click();
  await waitState("Downloading");
  assert.equal((await counts()).install, 1);
  assert.equal(await page.locator("#continue").isDisabled(), true);
  assert.equal(await page.locator("#progress").getAttribute("value"), "0.35");
  assert.match(await page.locator("#progress-label").textContent(), /Downloading 1\.0 of 2\.7 GB/);

  // Closing the Mac window keeps main alive. Dock activation must bring back
  // the active download rather than starting a workspace without its model.
  const closedWindow = page.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closedWindow;
  const reopenedWindow = app.waitForEvent("window");
  await app.evaluate(({ app }) => app.emit("activate"));
  page = await reopenedWindow;
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await waitState("Downloading");
  assert.equal((await counts()).install, 1, "Dock activation must retain the original download");
  assert.equal((await counts()).stackStarts, 0, "Dock activation must not start the workspace while downloading");
  assert.equal(await page.locator("#continue").isDisabled(), true);
  assert.equal(await page.locator("#progress").getAttribute("value"), "0.35");
  await page.getByRole("button", { name: "Cancel download" }).click();
  await waitState("Download cancelled");
  assert.equal((await counts()).cancel, 1);
  assert.equal(await page.locator("#continue").isEnabled(), true);

  await page.getByRole("button", { name: "Retry download / check" }).click();
  await waitState("Needs attention");
  assert.match(await page.getByRole("alert").textContent(), /connection interrupted/i);
  await page.getByRole("button", { name: "Retry download / check" }).click();
  await waitState("Downloading");
  assert.equal((await counts()).install, 3);
  await app.evaluate(() => globalThis.__modelHarness.completeInstall());
  await waitState("Ready");
  assert.equal(await page.locator("#install").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "Open local workspace" }).isEnabled(), true);
  assert.equal(await page.locator("#measurement").isVisible(), true);

  await page.getByRole("button", { name: "Run check" }).click();
  await page.waitForFunction(() => document.querySelector("#results")?.textContent.includes("3/3 expected facts correct"));
  assert.match(await page.locator("#results").textContent(), /1\.3 sec · 18\.4 tokens\/sec\. Smoke check passed/);
  await page.screenshot({ path: path.join(artifacts, "local-model-ready.png"), fullPage: true });
  await page.locator("#growth summary").click();
  await page.screenshot({ path: path.join(artifacts, "local-model-guide.png"), fullPage: true });
  await page.locator("#growth summary").click();
  await app.evaluate(() => globalThis.__modelHarness.failedMeasurement());
  await page.waitForFunction(() => document.querySelector("#results")?.textContent.includes("1/3 expected facts correct"));
  assert.match(await page.locator("#results").textContent(), /Check missed expected facts/);
  assert.doesNotMatch(await page.locator("#results").textContent(), /Smoke check passed/);
  await page.locator("#growth summary").click();
  await page.getByRole("button", { name: "Save a deployment brief" }).click();
  await page.waitForFunction(() => document.querySelector("#export-status")?.textContent.startsWith("Brief saved"));
  const exported = await app.evaluate(() => globalThis.__modelHarness.readExport());
  assert.match(exported, /ollama\/qwen3\.5:2b/);
  assert.doesNotMatch(exported, /NEVER-EXPORT|privateDebug/);

  await page.getByRole("button", { name: "Open local workspace" }).click();
  await page.getByRole("heading", { name: "Fixture local workspace" }).waitFor();
  assert.equal(await page.evaluate(() => window.mikeDesktop.readyLocalModel()), "ollama/qwen3.5:2b");
  assert.equal((await counts()).stackStarts, 1);

  await openManager();
  await waitState("Ready");
  const remoteUrl = await app.evaluate(() => globalThis.__modelHarness.remoteUrl);
  await page.evaluate((url) => window.mikeDesktop.setServerUrl(url), remoteUrl);
  // Navigation destroys this renderer; do not await its pending IPC promise.
  await page.evaluate(() => { void window.mikeDesktop.retry(); });
  await page.getByRole("heading", { name: "Fixture remote app", exact: true }).waitFor();
  const beforeForbiddenCalls = await counts();
  async function attemptPrivilegedCalls(frame) {
    return frame.evaluate(async () => {
      const bridge = window.mikeDesktop;
      return {
        install: await bridge.installLocalModel(), cancel: await bridge.cancelLocalModel(),
        benchmark: await bridge.benchmarkLocalModel(), status: await bridge.localModelStatus(),
        exported: await bridge.exportLocalModelBrief(), ready: await bridge.readyLocalModel(),
        guest: await bridge.guestCredentials(),
        serverBefore: await bridge.getServerUrl(),
        serverAfter: await bridge.setServerUrl("https://untrusted.example"),
        start: await bridge.startLocal(), open: await bridge.openLocalWorkspace(),
        connect: await bridge.openConnect(),
      };
    });
  }
  const blocked = await attemptPrivilegedCalls(page);
  for (const key of ["install", "cancel", "benchmark", "status", "ready", "guest"]) assert.equal(blocked[key], null, key);
  assert.equal(blocked.exported, false);
  assert.equal(blocked.serverAfter, blocked.serverBefore);
  assert.deepEqual(await counts(), beforeForbiddenCalls, "remote app must not invoke any model or export operation");
  assert.equal(page.url(), remoteUrl + "/");

  const frame = page.frameLocator('iframe[title="Untrusted child"]');
  await frame.getByRole("heading", { name: "Fixture remote app" }).waitFor();
  const child = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame());
  assert.ok(child, "fixture must contain a real child frame");
  assert.equal(await child.evaluate(() => typeof window.mikeDesktop?.installLocalModel), "function",
    "adversarial harness must expose the real preload inside the child frame");
  const childBlocked = await attemptPrivilegedCalls(child);
  assert.equal(childBlocked.install, null);
  assert.equal(childBlocked.exported, false);
  assert.equal(childBlocked.ready, null);
  assert.equal(childBlocked.serverAfter, remoteUrl);
  assert.deepEqual(await counts(), beforeForbiddenCalls, "child frame must not invoke model/export operations");

  await app.evaluate(() => globalThis.__modelHarness.unsupported());
  await openManager();
  await waitState("Not downloaded");
  assert.equal(await page.locator("#install").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Continue without local AI" }).isEnabled(), true);
  await page.getByRole("button", { name: "Continue without local AI" }).click();
  await page.getByRole("heading", { name: "Fixture local workspace" }).waitFor();
  assert.equal(await page.evaluate(() => window.mikeDesktop.readyLocalModel()), null);
  assert.deepEqual(errors, [], "the real onboarding renderer must not throw");
  console.log("PASS: explicit model download, Dock resume, progress/cancel/retry, measurements, export, unsupported hardware, remote and subframe IPC isolation");
  await app.close();
  app = null;

  // Start a separate app in saved local mode with model restoration pending.
  // Quitting must cancel that restoration and never launch the stack afterward.
  const restoreUserData = await mkdtemp(path.join(os.tmpdir(), "mike-model-onboarding-restore-"));
  testDirectories.push(restoreUserData);
  await writeFile(path.join(restoreUserData, "settings.json"), JSON.stringify({ mode: "local" }));
  app = await _electron.launch({
    executablePath: require("electron"), args: [path.join(here, "fixtures/model-onboarding-main.cjs")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MIKE_USER_DATA_DIR: restoreUserData,
      MIKE_SERVER_URL: "", MIKE_MODEL_FIXTURE_PENDING_RESTORE: "1",
      MIKE_E2E_CAPTURE_EXTERNAL: path.join(restoreUserData, "external-urls.txt"),
      MIKE_DOWNLOAD_DIR: path.join(restoreUserData, "downloads") }, timeout: 30000,
  });
  const restorePage = await app.firstWindow();
  restorePage.setDefaultTimeout(15000);
  await restorePage.getByRole("heading", { name: "Starting Mike on this Mac" }).waitFor();
  await restorePage.waitForFunction(() => document.querySelector("#status")?.textContent === "Starting your local model…");
  const restoringCounts = await counts();
  assert.equal(restoringCounts.restores, 1);
  assert.equal(restoringCounts.stackStarts, 0);
  const quit = app.waitForEvent("close");
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); });
  await quit;
  app = null;
  const quitCounts = JSON.parse(await readFile(path.join(restoreUserData, "lifecycle-counts.json"), "utf8"));
  assert.equal(quitCounts.stop, 1, "quit must stop the model manager");
  assert.equal(quitCounts.stackStarts, 0, "cancelled model restoration must not launch the stack during quit");
  assert.equal(quitCounts.stackStops, 1, "quit must finish stack cleanup");
  console.log("PASS: quit during model restoration cancels cleanly without starting the workspace stack");

  const shellUserData = await mkdtemp(path.join(os.tmpdir(), "mike-model-onboarding-shell-"));
  testDirectories.push(shellUserData);
  app = await _electron.launch({
    executablePath: require("electron"), args: [path.join(here, "fixtures/model-onboarding-main.cjs")],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MIKE_USER_DATA_DIR: shellUserData,
      MIKE_SERVER_URL: "", MIKE_MODEL_FIXTURE_NO_STACK: "1", MIKE_MODEL_FIXTURE_PENDING_RESTORE: "",
      MIKE_E2E_CAPTURE_EXTERNAL: path.join(shellUserData, "external-urls.txt"),
      MIKE_DOWNLOAD_DIR: path.join(shellUserData, "downloads") }, timeout: 30000,
  });
  const shellPage = await app.firstWindow();
  await shellPage.getByRole("heading", { name: "Fixture remote app", exact: true }).waitFor();
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items
    .flatMap((item) => item.submenu?.items || []).some((item) => item.label === "Local AI…")), false,
  "the shell-only app must not offer a local AI setup it cannot run");
  assert.equal((await counts()).created, 0);
  console.log("PASS: shell-only builds omit the Local AI menu and do not create a model manager");
} finally {
  if (app) await app.close();
  for (const directory of testDirectories) await rm(directory, { recursive: true, force: true });
}

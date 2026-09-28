// End-to-end proof of SELF-CONTAINED local mode: launch the app with a FRESH
// userData dir, choose this Mac, inspect optional AI without downloading it,
// then let the supervisor initdb + boot the whole stack
// (postgres, gotrue, postgrest, gateway, backend, frontend — no Docker, no
// network beyond loopback), then drive the real product over CDP: sign up and
// onboard, create a project, upload a document into the library, download it back
// — which round-trips the filesystem storage driver AND the blob-token
// signed-URL route.
//
// Two launch modes:
//   node e2e/local.e2e.mjs                  # packaged Mike.app (dist:local)
//   MIKE_E2E_DEV=1 node e2e/local.e2e.mjs   # electron . (repo dev mode)
//
// A fresh userData per run is the point: it exercises the first-run path a
// downloader hits (initdb → roles → gotrue migrations → schema.sql → ledger
// baseline) every single time.

import { _electron } from "playwright-core";
import { mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeOnboardingIfRequired,
  dismissFirstRunOverlay,
  packagedAppBinary,
  signUpThroughUi,
} from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(here, "..");
const DEV = process.env.MIKE_E2E_DEV === "1";
const APP_BINARY = DEV
  ? path.join(DESKTOP, "node_modules", ".bin", "electron")
  : packagedAppBinary(DESKTOP);
const FRONTEND_URL = "http://localhost:42815";
const ARTIFACTS = path.join(here, "artifacts");
const DOWNLOAD_DIR = path.join(ARTIFACTS, "local-downloads");
const CAPTURE_FILE = path.join(ARTIFACTS, "local-external-urls.txt");
const USER_DATA_DIR = path.join(ARTIFACTS, "local-userdata");
const DOWNLOAD_LOG = path.join(ARTIFACTS, "local-download-log.jsonl");
const PDF_FIXTURE = path.join(here, "..", "..", "e2e", "fixtures", "test.pdf");
const CDP_PORT = 9224;
const RUN_ID = Date.now().toString(36);
const EMAIL = `local-e2e-${RUN_ID}@example.com`;
const PASSWORD = `E2e!${RUN_ID}aA1`;
const PROJECT_NAME = `Local E2E ${RUN_ID}`;
const DOC_BASE = `local-doc-${RUN_ID}`;
const DOC_NAME = `${DOC_BASE}.pdf`;

// Fresh first-run every time.
rmSync(USER_DATA_DIR, { recursive: true, force: true });
rmSync(DOWNLOAD_LOG, { force: true });
mkdirSync(ARTIFACTS, { recursive: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readDownloadLog = () => {
  try {
    return readFileSync(DOWNLOAD_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
  console.log(`  📸 ${name}`);
};

const args = [
  ...(DEV ? ["."] : []),
  `--remote-debugging-port=${CDP_PORT}`,
];
let app;
let page;
const rendererErrors = [];

try {
  app = await _electron.launch({
    executablePath: APP_BINARY, args, cwd: DESKTOP, timeout: 30_000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      MIKE_SERVER_URL: "",
      MIKE_DOWNLOAD_DIR: DOWNLOAD_DIR,
      MIKE_E2E_CAPTURE_EXTERNAL: CAPTURE_FILE,
      MIKE_E2E_DOWNLOAD_LOG: DOWNLOAD_LOG,
      MIKE_USER_DATA_DIR: USER_DATA_DIR,
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  // Real bundled welcome -> optional AI page, including app.asar URLs and
  // production preload/main IPC authorization. No --local bypass is used.
  await page.getByRole("heading", { name: "Welcome to Mike", exact: true }).waitFor();
  await shot(page, "local-00-welcome");
  await page.getByRole("button", { name: /Start on this Mac/ }).click();
  await page.waitForURL((url) => url.pathname.endsWith("/pages/local-model.html"));
  if (!DEV) assert(page.url().includes("/app.asar/"), "local AI page was not loaded from the packaged app archive");
  await page.getByRole("heading", { name: "Qwen 3.5 2B", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "Not downloaded");
  const downloadModel = page.getByRole("button", { name: "Download local AI · 2.7 GB", exact: true });
  assert(await downloadModel.isEnabled(), "the supported Mac did not offer the optional 2B download");
  assert(!existsSync(path.join(USER_DATA_DIR, "local", "local-model.json")), "onboarding installed a model without a download click");
  assert(!existsSync(path.join(USER_DATA_DIR, "local", "models", "blobs")), "onboarding started downloading model blobs automatically");
  await shot(page, "local-00-model-optional");
  await page.getByRole("button", { name: "Continue without local AI", exact: true }).click();
  console.log("✓ packaged welcome → optional 2B / 2.7 GB page → continue without model; no automatic download");

  // 1. First-run boot: the window shows the local-boot progress page while
  //    the supervisor initdbs and starts six services, then lands on the
  //    LOCAL frontend's /login. Generous timeout — this is a cold initdb.
  await page.waitForURL((url) => url.href.startsWith(FRONTEND_URL), {
    timeout: 180_000,
  });
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  console.log("✓ local stack booted from scratch; app routed to /login");
  await shot(page, "local-01-login");

  // 2. Sign up — GoTrue autoconfirms, entirely offline. Because it
  //    autoconfirms, signUp returns a session and the page pushes to
  //    /onboarding/profile rather than /signup/check-email, so the wizard is
  //    part of the offline path too (the profile writes go to local postgres
  //    through the local backend — still no network).
  await signUpThroughUi(page, { email: EMAIL, password: PASSWORD });
  await page.waitForURL((url) => !/\/(login|signup)/.test(url.href), {
    timeout: 30_000,
  });
  await completeOnboardingIfRequired(page, {
    name: "Local E2E",
    organisation: "Mike Local CI",
  });
  await page
    .getByRole("button", { name: "Assistant", exact: true })
    .first()
    .waitFor({ timeout: 20_000 });
  console.log(`✓ signed up + onboarded + auto-signed-in as ${EMAIL} (no network)`);
  await shot(page, "local-02-signed-in");

  // 2b. Dismiss any first-run overlay (welcome / API-key modal).
  await dismissFirstRunOverlay(page);

  // 3. Create a project through the real wizard.
  await page.goto(`${FRONTEND_URL}/projects`);
  const createBtn = page.getByRole("button", { name: "New project", exact: true });
  await createBtn.waitFor({ timeout: 15_000 });
  await createBtn.click();
  await page.getByPlaceholder("Add project name").fill(PROJECT_NAME);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("dialog", { name: "Access", exact: true }).waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("dialog", { name: "Add Documents", exact: true })
    .getByRole("button", { name: "Create project", exact: true })
    .click({ timeout: 15_000 });
  await page.getByText(PROJECT_NAME, { exact: false }).first().waitFor({ timeout: 20_000 });
  console.log(`✓ project "${PROJECT_NAME}" created (data in local postgres)`);
  await shot(page, "local-03-project");

  // 4. Upload a PDF to the library → exercises the fs storage driver's write
  //    path (multipart to backend → STORAGE_FS_ROOT under userData).
  await page.goto(`${FRONTEND_URL}/library`);
  const addBtn = page.getByRole("button", { name: "Upload", exact: true }).first();
  await addBtn.waitFor({ timeout: 15_000 });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await addBtn.click();
  await page.getByRole("menuitem", { name: "Upload files", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: DOC_NAME,
    mimeType: "application/pdf",
    buffer: readFileSync(PDF_FIXTURE),
  });
  await page.getByText(DOC_BASE, { exact: false }).first().waitFor({ timeout: 30_000 });

  // The table row renders before the backend finishes persisting, so poll —
  // the bytes land under STORAGE_FS_ROOT shortly after.
  const storageRoot = path.join(USER_DATA_DIR, "local", "storage");
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const storageDeadline = Date.now() + 30_000;
  let stored = [];
  while (Date.now() < storageDeadline) {
    stored = existsSync(storageRoot) ? walk(storageRoot).filter((file) => !file.startsWith(path.join(storageRoot, "mike-workflows") + path.sep)) : [];
    if (stored.length > 0) break;
    await sleep(1_000);
  }
  assert(stored.length > 0, "upload produced no file under the fs storage root");
  console.log(`✓ upload landed as plain files under userData/local/storage (${stored.length} object[s])`);

  // 5. Row menu → Download: the backend mints a blob-token signed URL
  //    (getSignedUrl, fs driver), the browser follows it with no auth
  //    header, the shell's will-download handler saves it. Waits out
  //    ingestion like flows.e2e.mjs does.
  const rowFor = () =>
    page
      .locator("div")
      .filter({ hasText: DOC_BASE })
      .filter({ has: page.getByRole("button", { name: "Open row actions" }) })
      .last();
  let menuBtn = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const candidate = rowFor().getByRole("button", { name: "Open row actions" }).first();
    if (await candidate.isVisible().catch(() => false)) {
      menuBtn = candidate;
      break;
    }
    await sleep(6_000);
    await page.reload().catch(() => {});
    await page.getByText(DOC_BASE, { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => {});
  }
  assert(menuBtn, "document never finished processing (row menu never appeared)");

  const before = readDownloadLog().length;
  await menuBtn.click();
  await page
    .getByRole("button", { name: "Download", exact: true })
    .first()
    .click({ timeout: 10_000 });
  let entry = null;
  const dlDeadline = Date.now() + 20_000;
  while (Date.now() < dlDeadline && !entry) {
    entry = readDownloadLog().slice(before).find((e) => e.state === "completed");
    if (!entry) await sleep(400);
  }
  assert(entry, "download never completed via the shell handler");
  assert(
    entry.url.includes("/download/signed/"),
    `expected a blob-token signed URL, got: ${entry.url}`,
  );
  console.log(`✓ downloaded back via blob-token URL: ${path.basename(entry.savePath)}`);
  await shot(page, "local-04-download");

  // 6. Guest mode: from a signed-out /login, "Continue on this Mac" must land
  //    in the product with zero typing. Run it twice — the first click hits
  //    the signUp fallback (the guest account doesn't exist yet), the second
  //    proves signInWithPassword against the account the first one created.
  //
  //    The local guest path completes optional onboarding automatically.
  //    Retain the helper as a no-op for already-complete accounts.
  for (const round of ["first click (creates the guest account)", "second click (signs into it)"]) {
    // Auth now lives in httpOnly cookies; clearing localStorage does not log out.
    await page.evaluate(async () => {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "local" }),
      });
      if (!response.ok) throw new Error("Local logout failed");
    });
    await page.goto(`${FRONTEND_URL}/login`);
    const guestBtn = page.getByRole("button", { name: "Continue on this Mac" });
    await guestBtn.waitFor({ timeout: 15_000 });
    await guestBtn.click();
    await page.waitForURL((url) => !/\/(login|signup)/.test(url.href), {
      timeout: 30_000,
    });
    await completeOnboardingIfRequired(page, {
      name: "Local Guest",
      organisation: "Mike Local CI",
    });
    await page
      .getByRole("button", { name: "Assistant", exact: true })
      .first()
      .waitFor({ timeout: 20_000 });
    console.log(`✓ guest mode, ${round}: /login → signed-in product`);
  }
  await shot(page, "local-05-guest");
  assert(rendererErrors.length === 0, "the packaged app renderer raised an error");
  assert(!existsSync(path.join(USER_DATA_DIR, "local", "models", "blobs")), "continuing without AI downloaded model blobs");

  writeFileSync(
    path.join(ARTIFACTS, "local-summary.json"),
    JSON.stringify(
      { ok: process.exitCode !== 1, EMAIL, PROJECT_NAME, download: entry,
        optionalModel: "ollama/qwen3.5:2b", modelDownloaded: false, rendererErrors },
      null,
      2,
    ),
  );
  console.log(process.exitCode === 1 ? "LOCAL E2E FAILED" : "LOCAL E2E PASSED");
} catch (err) {
  fail(err.message);
  try {
    if (page) await shot(page, "local-99-failure");
  } catch { /* app already gone */ }
} finally {
  // Exercise before-quit so Postgres and every supervised child stop cleanly.
  if (app) await app.close();
}

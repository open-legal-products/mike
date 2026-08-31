// End-to-end proof of SELF-CONTAINED local mode: launch the app with --local
// and a FRESH userData dir, let the supervisor initdb + boot the whole stack
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

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
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

async function waitForCdp(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("CDP endpoint never came up — did the app launch?");
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
  console.log(`  📸 ${name}`);
};

const args = [
  ...(DEV ? ["."] : []),
  `--remote-debugging-port=${CDP_PORT}`,
  "--local",
];
const app = spawn(APP_BINARY, args, {
  stdio: "ignore",
  detached: false,
  cwd: DESKTOP,
  env: {
    ...process.env,
    MIKE_DOWNLOAD_DIR: DOWNLOAD_DIR,
    MIKE_E2E_CAPTURE_EXTERNAL: CAPTURE_FILE,
    MIKE_E2E_DOWNLOAD_LOG: DOWNLOAD_LOG,
    MIKE_USER_DATA_DIR: USER_DATA_DIR,
  },
});

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools"));
  if (!page) throw new Error("no app page found over CDP");

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
  const wizard = page.locator("div.fixed.inset-0").last();
  await wizard
    .getByRole("button", { name: "Create project", exact: true })
    .click({ timeout: 15_000 });
  await page.getByText(PROJECT_NAME, { exact: false }).first().waitFor({ timeout: 20_000 });
  console.log(`✓ project "${PROJECT_NAME}" created (data in local postgres)`);
  await shot(page, "local-03-project");

  // 4. Upload a PDF to the library → exercises the fs storage driver's write
  //    path (multipart to backend → STORAGE_FS_ROOT under userData).
  await page.goto(`${FRONTEND_URL}/library`);
  const addBtn = page.getByRole("button", { name: "Add Files" });
  await addBtn.waitFor({ timeout: 15_000 });
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await addBtn.click();
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
    stored = existsSync(storageRoot) ? walk(storageRoot) : [];
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
      .filter({ has: page.getByRole("button", { name: "···" }) })
      .last();
  let menuBtn = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const candidate = rowFor().getByRole("button", { name: "···" }).first();
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

  // 6. Guest mode: from a signed-out /login, "Continue as guest" must land
  //    in the product with zero typing. Run it twice — the first click hits
  //    the signUp fallback (the guest account doesn't exist yet), the second
  //    proves signInWithPassword against the account the first one created.
  //
  //    Both clicks push to /onboarding/profile (the guest handler in
  //    frontend/src/app/login/page.tsx sends every guest to the same place a
  //    password login goes), and OnboardingGate then decides: round one is a
  //    brand-new account, so it stays on the wizard and we walk it; round two
  //    is the SAME account coming back with onboarding already complete, so
  //    the gate bounces it straight to /assistant and the helper is a no-op.
  //    That asymmetry is the interesting half of the guest story, which is why
  //    the same helper runs in both rounds instead of only the first.
  for (const round of ["first click (creates the guest account)", "second click (signs into it)"]) {
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${FRONTEND_URL}/login`);
    const guestBtn = page.getByRole("button", { name: "Continue as guest" });
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

  writeFileSync(
    path.join(ARTIFACTS, "local-summary.json"),
    JSON.stringify(
      { ok: process.exitCode !== 1, EMAIL, PROJECT_NAME, download: entry },
      null,
      2,
    ),
  );
  await browser.close();
  console.log(process.exitCode === 1 ? "LOCAL E2E FAILED" : "LOCAL E2E PASSED");
} catch (err) {
  fail(err.message);
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (page) await shot(page, "local-99-failure");
    await browser.close();
  } catch { /* app already gone */ }
} finally {
  app.kill();
  // Give the supervisor's before-quit shutdown a moment (clean pg stop).
  await sleep(4_000);
}

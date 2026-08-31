// End-to-end proof that the packaged Mike.app hosts the real product against
// a real local stack: launches the packaged Mike.app (dist/mac-arm64 on Apple
// silicon, dist/mac on Intel) with a debugging port, drives it with Playwright
// over CDP (the shell's window IS a Chromium page), signs up and onboards a
// fresh user, creates a project, and screenshots each stage.
//
// Prereqs: the docker-compose stack is up and the app has been packaged
// (npm run dist). Run from desktop/:
//   node e2e/app.e2e.mjs
//   MIKE_E2E_URL=http://localhost:3100 node e2e/app.e2e.mjs   # shifted stack
//
// The app is launched with --server-url=$MIKE_E2E_URL (default
// http://localhost:3000) plus MIKE_DOWNLOAD_DIR and MIKE_E2E_CAPTURE_EXTERNAL
// pointed into e2e/artifacts/, so a test run never reads or writes the user's
// real settings.json, ~/Downloads, or default browser.
//
// Driving over CDP deliberately exercises the same binary a user double-clicks
// — not `electron .` — so packaging regressions (asar paths, resources) fail
// the test too. Native menu items can't be driven over CDP; menu coverage is
// manual for now.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeOnboardingIfRequired,
  dismissFirstRunOverlay,
  packagedAppBinary,
  signUpThroughUi,
} from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_BINARY = packagedAppBinary(path.join(here, ".."));
const ARTIFACTS = path.join(here, "artifacts");
// Where the app under test points. Trailing slash stripped so `${SERVER_URL}/x`
// composes cleanly.
const SERVER_URL = (process.env.MIKE_E2E_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const DOWNLOAD_DIR = path.join(ARTIFACTS, "downloads");
const CAPTURE_FILE = path.join(ARTIFACTS, "external-urls.txt");
// Isolated userData: never touch the developer's real settings/window bounds,
// and never collide with a running Mike.app on the single-instance lock.
const USER_DATA_DIR = path.join(ARTIFACTS, "userdata");
const CDP_PORT = 9223;
const RUN_ID = Date.now().toString(36);
const EMAIL = `desktop-e2e-${RUN_ID}@example.com`;
const PASSWORD = `E2e!${RUN_ID}aA1`;
const PROJECT_NAME = `Desktop E2E ${RUN_ID}`;

mkdirSync(ARTIFACTS, { recursive: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

async function waitForCdp(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("CDP endpoint never came up — did the app launch?");
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
  console.log(`  📸 ${name}`);
};

const app = spawn(
  APP_BINARY,
  [`--remote-debugging-port=${CDP_PORT}`, `--server-url=${SERVER_URL}`],
  {
    stdio: "ignore",
    detached: false,
    // Sandbox the run: downloads land in artifacts, would-be openExternal
    // calls are captured to a file instead of spraying real browser tabs.
    env: {
      ...process.env,
      MIKE_DOWNLOAD_DIR: DOWNLOAD_DIR,
      MIKE_E2E_CAPTURE_EXTERNAL: CAPTURE_FILE,
      MIKE_USER_DATA_DIR: USER_DATA_DIR,
    },
  },
);

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${CDP_PORT}`,
  );
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools"));
  if (!page) throw new Error("no app page found over CDP");

  // 1. The shell must have connected to the real server (not the offline
  //    screen). The shell persists sessions across launches (that's a
  //    feature), so a prior run's login may still be live — reset to an
  //    anonymous state before asserting the /login redirect.
  await page.waitForURL((url) => url.href.startsWith(SERVER_URL), {
    timeout: 15_000,
  });
  if (!/\/login/.test(page.url())) {
    await context.clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto(`${SERVER_URL}/`);
  }
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  console.log("✓ shell connected; anonymous user routed to /login");
  await shot(page, "01-login");

  // 2. Sign up a fresh user through the product UI (local stack autoconfirms),
  //    then walk the two-step onboarding wizard signup now hands off to.
  await signUpThroughUi(page, { email: EMAIL, password: PASSWORD });
  // URL change alone can lie (a failed signup can still bounce through "/") —
  // signup succeeded is when we're off the auth pages entirely...
  await page.waitForURL((url) => !/\/(login|signup)/.test(url.href), {
    timeout: 30_000,
  });
  await completeOnboardingIfRequired(page, {
    name: "Desktop E2E",
    organisation: "Mike Desktop CI",
  });
  // ...and authenticated is when the app sidebar renders. Onboarding's own
  // shell has no sidebar, so this assertion only passes once the wizard has
  // actually released us into the product.
  await page
    .getByRole("button", { name: "Assistant", exact: true })
    .first()
    .waitFor({ timeout: 20_000 });
  console.log(`✓ signed up + onboarded + auto-signed-in as ${EMAIL}`);
  await shot(page, "02-signed-in");

  // 2b. Dismiss any first-run overlay (welcome / API-key modal).
  await dismissFirstRunOverlay(page);

  // 3. Create a project through the real UI (current design: the header's
  //    "New project" icon button opens a wizard — name → Next → optional
  //    documents step).
  await page.goto(`${SERVER_URL}/projects`);
  const createBtn = page.getByRole("button", {
    name: "New project",
    exact: true,
  });
  await createBtn.waitFor({ timeout: 15_000 });
  await createBtn.click();
  await page.getByPlaceholder("Add project name").fill(PROJECT_NAME);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  // Step 2 of the wizard is "Add Documents" — create without any, scoped to
  // the wizard overlay so the toolbar's own "Create" (behind the backdrop)
  // can't be matched.
  const wizard = page.locator("div.fixed.inset-0").last();
  await wizard
    .getByRole("button", { name: "Create project", exact: true })
    .click({ timeout: 15_000 });
  await page
    .getByText(PROJECT_NAME, { exact: false })
    .first()
    .waitFor({ timeout: 20_000 });
  console.log(`✓ project "${PROJECT_NAME}" created and visible`);
  await shot(page, "03-project-created");

  // 4. Wordmark sanity: the sidebar/app chrome rendered (not an error page).
  //    Read via waitForFunction — document.title is briefly empty during
  //    client-side transitions, and a one-shot read can catch that window.
  const titleOk = await page
    .waitForFunction(() => /mike/i.test(document.title), null, {
      timeout: 10_000,
    })
    .catch(() => null);
  const title = await page.title();
  if (!titleOk) fail(`unexpected page title: ${title}`);
  console.log(`✓ page title: ${title}`);

  writeFileSync(
    path.join(ARTIFACTS, "summary.json"),
    JSON.stringify({ ok: process.exitCode !== 1, EMAIL, PROJECT_NAME }, null, 2),
  );
  await browser.close();
  console.log(process.exitCode === 1 ? "E2E FAILED" : "E2E PASSED");
} catch (err) {
  fail(err.message);
  try {
    // Best-effort failure screenshot for diagnosis.
    const browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${CDP_PORT}`,
    );
    const page = browser.contexts()[0]?.pages()[0];
    if (page) await shot(page, "99-failure");
    await browser.close();
  } catch {
    /* app already gone */
  }
} finally {
  app.kill();
}

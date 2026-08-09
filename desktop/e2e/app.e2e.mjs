// End-to-end proof that the packaged Mike.app hosts the real product against
// a real local stack: launches dist/mac-arm64/Mike.app with a debugging port,
// drives it with Playwright over CDP (the shell's window IS a Chromium page),
// signs up a fresh user, creates a project, and screenshots each stage.
//
// Prereqs: the docker-compose stack is up (frontend on :3000) and the app has
// been packaged (npm run dist). Run from desktop/:
//   node e2e/app.e2e.mjs
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

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_BINARY = path.join(
  here,
  "..",
  "dist",
  "mac-arm64",
  "Mike.app",
  "Contents",
  "MacOS",
  "Mike",
);
const ARTIFACTS = path.join(here, "artifacts");
const CDP_PORT = 9223;
const RUN_ID = Date.now().toString(36);
const EMAIL = `desktop-e2e-${RUN_ID}@example.com`;
const PASSWORD = `E2e!${RUN_ID}aA1`;
const PROJECT_NAME = `Desktop E2E ${RUN_ID}`;

mkdirSync(ARTIFACTS, { recursive: true });

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

const app = spawn(APP_BINARY, [`--remote-debugging-port=${CDP_PORT}`], {
  stdio: "ignore",
  detached: false,
});

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
  await page.waitForURL(/localhost:3000/, { timeout: 15_000 });
  if (!/\/login/.test(page.url())) {
    await context.clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto("http://localhost:3000/");
  }
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  console.log("✓ shell connected; anonymous user routed to /login");
  await shot(page, "01-login");

  // 2. Sign up a fresh user through the product UI (local stack autoconfirms).
  await page.getByRole("link", { name: "Sign up" }).click();
  await page.waitForURL(/\/signup/, { timeout: 15_000 });
  await page.getByPlaceholder("Your name").fill("Desktop E2E");
  await page.getByPlaceholder("Your organisation").fill("Mike Desktop CI");
  await page.getByPlaceholder("Enter your email").fill(EMAIL);
  await page
    .getByPlaceholder("Create a password (min. 6 characters)")
    .fill(PASSWORD);
  await page.getByPlaceholder("Confirm your password").fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  // URL change alone can lie (a failed signup can still bounce through "/") —
  // authenticated is when the app sidebar renders.
  await page.waitForURL((url) => !/\/(login|signup)/.test(url.href), {
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: "Assistant", exact: true })
    .first()
    .waitFor({ timeout: 20_000 });
  console.log(`✓ signed up + auto-signed-in as ${EMAIL}`);
  await shot(page, "02-signed-in");

  // 2b. Dismiss any first-run overlay (welcome / API-key modal). Try its own
  //     dismiss affordances first, then Escape; give up after a few rounds.
  for (let i = 0; i < 5; i++) {
    const overlay = page.locator("div.fixed.inset-0").last();
    if (!(await overlay.isVisible().catch(() => false))) break;
    let clicked = false;
    for (const name of [/skip/i, /later/i, /got it/i, /continue/i, /close/i]) {
      const btn = overlay.getByRole("button", { name }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }

  // 3. Create a project through the real UI (current design: "Create" opens
  //    a wizard — name → Next → optional documents step).
  await page.goto("http://localhost:3000/projects");
  const createBtn = page.getByRole("button", { name: "Create", exact: true });
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
  const title = await page.title();
  if (!/mike/i.test(title)) fail(`unexpected page title: ${title}`);
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

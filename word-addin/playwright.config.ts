import { defineConfig, devices } from "@playwright/test";

/**
 * E2E config for the Mike Word add-in.
 *
 * SERVE STRATEGY: We build the add-in for production (`build:e2e`, with fixed
 * REACT_APP_* values so route globs are predictable) and static-serve `dist/`
 * over PLAIN HTTP on a fixed port. We deliberately avoid the webpack dev server:
 * it serves over self-signed HTTPS (office-addin-dev-certs) which can prompt for
 * a keychain password and flake in CI. A static HTTP server is hermetic and
 * deterministic; the Office.js globals are provided by an in-page shim
 * (see e2e/support/office-mock.ts), so nothing here needs the real Office host.
 *
 * Tests are fully hermetic — every backend call is intercepted with page.route
 * inside the shared fixture; no live API/Supabase is ever contacted.
 */
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // The Office shim, recorded Word calls and every backend route are installed
  // per page (e2e/support), so files share no state and CI spreads them over
  // parallel workers (E2E_WORKERS in .github/workflows/word-addin.yml). Tests
  // inside a file still run in order. Local runs stay serial by default.
  fullyParallel: false,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 1,
  forbidOnly: !!process.env.CI,
  // A timing-dependent stress failure must not become green on retry.
  retries: process.env.REACT_STRESS === "1" ? 0 : process.env.CI ? 2 : 0,
  timeout: process.env.REACT_STRESS === "1" ? 90_000 : 30_000,
  expect: { timeout: process.env.REACT_STRESS === "1" ? 10_000 : 5_000 },
  // Keep per-test progress visible during the longer development stress run.
  reporter: process.env.CI ? [["github"], ["list"]] : "list",

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? BASE_URL,
    screenshot: "only-on-failure",
    trace: process.env.REACT_STRESS === "1" ? "retain-on-failure" : "on-first-retry",
    // PW_VIDEO=1 records a webm per test (for demo/review reels); off by
    // default because videos slow the suite and bloat CI artifacts.
    video: process.env.PW_VIDEO === "1"
      ? { mode: "on", size: { width: 1280, height: 720 } }
      : "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // WebKit is NOT redundant coverage here: WKWebView (the Word-on-Mac task
    // pane host) ignores `overflow-anchor: none` and re-anchors scrollTop when
    // a descendant resizes, while Chromium honours the opt-out. The scroll
    // pinning assertions in e2e/chat-layout.spec.ts only bite under this
    // project — dropping it silently un-tests the WebKit scroll fix.
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],

  // WORD_E2E_DEVELOPMENT=1 exercises React development-only warnings with
  // the same static server and Office mocks (no HTTPS/keychain dependency).
  // Build the production bundle by default, then static-serve dist/ over HTTP. Build runs
  // here so `npx playwright test` works standalone; reuse a running server
  // locally to avoid rebuilding on every invocation.
  webServer: {
    command: `npm run ${process.env.WORD_E2E_DEVELOPMENT === "1" ? "build:e2e:development" : "build:e2e"} && npm run serve:e2e`,
    url: `${BASE_URL}/taskpane.html`,
    reuseExistingServer: !process.env.CI,
    // Generous because the command includes a cold typecheck + production
    // webpack build on CI runners; a webServer timeout aborts the whole run
    // (retries never apply to it).
    timeout: 300_000,
  },
});

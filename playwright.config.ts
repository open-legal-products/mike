import { defineConfig, devices } from "@playwright/test";

/**
 * Run `npx playwright install` to download the browsers.
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
    testDir: "./e2e",
    /* These E2E tests run against a single shared backend and a single shared
       test user (e2e@mike.local). Running them concurrently causes data races
       on shared list views (projects/chats/workflows) and on the user's
       session, producing flaky pass/fail that can't be trusted for regression
       detection. So we run strictly one test at a time. */
    fullyParallel: false,
    workers: 1,
    /* Fail the build on CI if you accidentally left test.only in the source */
    forbidOnly: !!process.env.CI,
    /* Playwright's assertion default is 5s, which is tight for this app's first
       paint after a cold Next.js dev compile — so nearly every expect() in the
       suite hand-rolled its own `{ timeout: 10_000 }`. Make that the project
       default: new assertions inherit it, and only genuinely slower waits need
       to spell out an override. */
    expect: { timeout: 10_000 },
    /* Retry on CI only */
    retries: process.env.CI ? 2 : 0,
    /* Reporter. On CI, "github" alone would REPLACE Playwright's default html
       reporter, so playwright-report/ would never be written and the workflow's
       artifact upload (docs/e2e-ci.md, "Failure artifacts") would have nothing
       to ship. Listing both keeps the inline PR annotations AND generates the
       HTML report; `open: "never"` stops the reporter from trying to launch a
       browser on the CI box after the run. */
    reporter: process.env.CI
        ? [["github"], ["html", { open: "never" }]]
        : "list",
    /* Shared settings for all the projects below */
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
        trace: "on-first-retry",
        screenshot: "only-on-failure",
    },

    projects: [
        /* Run the auth setup before all other tests */
        {
            name: "setup",
            testMatch: /auth\.setup\.ts/,
        },

        {
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],
                storageState: "e2e/.auth/user.json",
            },
            dependencies: ["setup"],
        },
    ],

    /* Start the backend and the Next.js dev server when running locally.
       The backend command first runs the local-stack setup (Docker check,
       supabase start, schema + migrations + grants, env wiring) so a plain
       `npm run test:e2e` works against a ready local Supabase — see
       scripts/e2e-local-stack.sh. Idempotent: a few seconds when already up. */
    webServer: process.env.CI
        ? undefined
        : [
              {
                  command:
                      "bash ../scripts/e2e-local-stack.sh --setup-only && npm run dev",
                  cwd: "backend",
                  url: "http://localhost:3001/health",
                  reuseExistingServer: true,
                  timeout: 120_000,
              },
              {
                  command: "npm run dev",
                  cwd: "frontend",
                  url: "http://localhost:3000",
                  reuseExistingServer: true,
                  timeout: 120_000,
              },
          ],
});

import fs from "fs";
import path from "path";
import { test as base, expect } from "@playwright/test";
import { completeOnboardingIfRequired } from "./onboarding";
import { ensureUser, workerAccount, type E2eAccount } from "./users";
export { expect };
export type { Page } from "@playwright/test";

type WorkerFixtures = {
    /** The user this worker signs in as; see workerAccount() in users.ts. */
    e2eAccount: E2eAccount;
    /** Path to this worker's signed-in session, created once per worker. */
    workerStorageState: string;
};

export const test = base.extend<object, WorkerFixtures>({
    e2eAccount: [
        async ({}, use, workerInfo) => {
            await use(workerAccount(workerInfo.parallelIndex));
        },
        { scope: "worker" },
    ],

    /* Each worker signs in once as its own account and every authenticated
       test in that worker reuses the session. A spec that needs a signed-out
       page still opts out with test.use({ storageState: { cookies: [], origins: [] } }),
       which overrides this fixture and never triggers the sign-in. The file
       lives in the project's output dir, which Playwright clears at the start
       of each run, so a stale session from an earlier run is never reused. */
    workerStorageState: [
        async ({ browser, e2eAccount }, use, workerInfo) => {
            const file = path.resolve(
                workerInfo.project.outputDir,
                `.auth/worker-${workerInfo.parallelIndex}.json`,
            );
            if (!fs.existsSync(file)) {
                await ensureUser(e2eAccount.email, e2eAccount.password);
                const page = await browser.newPage({
                    storageState: undefined,
                    baseURL: workerInfo.project.use.baseURL,
                });
                await page.goto("/login");
                await expect(page).toHaveURL(/\/login/);
                await page.fill("#email", e2eAccount.email);
                await page.fill("#password", e2eAccount.password);
                await page.click('button[type="submit"]');
                /* A new account must finish onboarding before its session
                   lands on the app; an onboarded one goes straight to
                   /assistant. */
                await completeOnboardingIfRequired(page);
                await page.context().storageState({ path: file });
                await page.close();
            }
            await use(file);
        },
        { scope: "worker" },
    ],

    storageState: async ({ workerStorageState }, use) => {
        await use(workerStorageState);
    },

    /** Opt-in development stress profile shared by every browser flow. */
    page: async ({ page, browserName }, use) => {
        if (process.env.REACT_STRESS !== "1") {
            await use(page);
            return;
        }
        const diagnostics: string[] = [];
        const record = (message: string) => {
            if (/maximum update depth|too many re-renders|getSnapshot.*cached|ResizeObserver loop/i.test(message)) {
                diagnostics.push(message);
            }
        };
        page.on("console", (message) => record(message.text()));
        page.on("pageerror", (error) => record(error.message));
        if (browserName === "chromium") {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        }
        await use(page);
        expect(diagnostics, "React/observer feedback-loop diagnostics").toEqual([]);
    },
});

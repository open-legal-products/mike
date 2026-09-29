import { test as base, expect } from "@playwright/test";
export { expect };
export type { Page } from "@playwright/test";

/** Opt-in development stress profile shared by every browser flow. */
export const test = base.extend({
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

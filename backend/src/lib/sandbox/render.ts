import type { Browser } from "playwright-core";
import { sandboxLimits } from "./limits";
import { BLOCKS_PAGE_WIDTH, collectBlocks } from "./blocks";
import { createSlots, type Slots } from "./slots";
import type { BlocksOutcome, CheckOutcome, PdfOutcome, RenderOutcome, RenderRequest } from "./types";

const VIEWPORT_WIDTH = 680;
const SCALE = 2;
const MAX_PDF_PAGES = 60;
const MAX_PAGE_ERRORS = 5;
const MAX_ERROR_CHARS = 300;
const RENDERS_PER_BROWSER = 200;
const LAUNCH_ARGS = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=256"];

export class VisualRenderer {
    private browser: Promise<Browser> | null = null;
    private renders = 0;
    private readonly slots: Slots;
    private readonly limits: ReturnType<typeof sandboxLimits>;

    constructor(limits: Partial<ReturnType<typeof sandboxLimits>> = {}) {
        this.limits = { ...sandboxLimits(), ...limits };
        this.slots = createSlots(this.limits.renderConcurrency, this.limits.queueWaitMs);
    }

    private launch(): Promise<Browser> {
        if (!this.browser) {
            this.renders = 0;
            this.browser = import("playwright-core").then(({ chromium }) =>
                chromium.launch({ headless: true, args: LAUNCH_ARGS }),
            );
            this.browser.catch(() => {
                this.browser = null;
            });
        }
        return this.browser;
    }

    async available(): Promise<boolean> {
        try {
            await this.launch();
            return true;
        } catch {
            return false;
        }
    }

    private async discard() {
        const pending = this.browser;
        this.browser = null;
        const browser = await pending?.catch(() => null);
        // Closing goes to the browser process, not the hung renderer; a
        // close that still stalls is abandoned with the old instance.
        await Promise.race([browser?.close(), new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => undefined);
    }

    render(req: { html: string; format: "pdf" }): Promise<PdfOutcome>;
    render(req: { html: string; format: "blocks" }): Promise<BlocksOutcome>;
    render(req: { html: string; format: "check" }): Promise<CheckOutcome>;
    render(req: RenderRequest): Promise<RenderOutcome>;
    async render(req: RenderRequest): Promise<RenderOutcome> {
        if (!(await this.slots.acquire())) return { ok: false, code: "render_busy" };
        let timedOut = false;
        let timer: NodeJS.Timeout | null = null;
        try {
            const browser = await this.launch().catch(() => null);
            if (!browser) return { ok: false, code: "render_unavailable" };
            const deadline = new Promise<RenderOutcome>((resolve) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    resolve({ ok: false, code: "render_timeout" });
                }, this.limits.renderTimeoutMs);
            });
            const outcome = await Promise.race([this.renderWith(browser, req), deadline]);
            // A hung page holds the whole browser; it is replaced for the next render.
            if (timedOut) await this.discard();
            else if (++this.renders >= RENDERS_PER_BROWSER) await this.discard();
            return outcome;
        } finally {
            if (timer) clearTimeout(timer);
            this.slots.release();
        }
    }

    private async renderWith(browser: Browser, req: RenderRequest): Promise<RenderOutcome> {
        const width = req.format === "blocks" ? BLOCKS_PAGE_WIDTH : VIEWPORT_WIDTH;
        const context = await browser.newContext({
            viewport: { width, height: 1000 },
            deviceScaleFactor: SCALE,
            colorScheme: "light",
            serviceWorkers: "block",
            acceptDownloads: false,
            javaScriptEnabled: true,
        });
        try {
            await context.route("**/*", (route) => route.abort());
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => {
                if (errors.length < MAX_PAGE_ERRORS) errors.push(`${error.name}: ${error.message}`.slice(0, MAX_ERROR_CHARS));
            });
            await page.setContent(req.html, { waitUntil: "load" });
            const readyWait = Math.min(4000, this.limits.renderTimeoutMs / 2);
            await page
                .waitForFunction(() => document.documentElement.dataset.mvReady === "1", null, { timeout: readyWait })
                .catch(() => page.evaluate(() => document.fonts.ready.then(() => undefined)).then(() => page.waitForTimeout(300)));
            if (req.format === "check") return { ok: true, errors };
            if (req.format === "blocks") return { ok: true, blocks: await collectBlocks(page, SCALE) };
            await page.emulateMedia({ media: "print" });
            const bytes = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, tagged: true });
            const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
            if (pages > MAX_PDF_PAGES) return { ok: false, code: "render_failed" };
            return { ok: true, bytes };
        } catch {
            return { ok: false, code: "render_failed" };
        } finally {
            await context.close().catch(() => undefined);
        }
    }

    async shutdown() {
        await this.discard();
    }
}

import { expect, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] }, actionTimeout: 30_000 });

test("tabular chat keeps the latest of sixteen selections when long histories arrive backwards", async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
        const pending: { id: string; resolve: (response: Response) => void }[] = [];
        const controls = window as Window & { pendingHistoryCount?: number; finishHistories?: () => Promise<void> };
        controls.finishHistories = async () => {
            for (let index = pending.length - 1; index >= 0; index--) {
                pending[index].resolve(json(Array.from({ length: 16 }, (_, turn) => [
                    { id: `u-${turn}`, chat_id: pending[index].id, role: "user", content: `Question ${turn}` },
                    { id: `a-${turn}`, chat_id: pending[index].id, role: "assistant", content: [{ type: "content", text:
                        `${"Synthetic clause. **Review** the terms.\n\n".repeat(30)}Selection ${index}, answer ${turn}` }] },
                ]).flat()));
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        };
        window.fetch = async (input, init) => {
            const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
            if (!path.startsWith("/api/")) return originalFetch(input, init);
            if (path === "/api/auth/session") return json({ user: { id: "stress-user", email: "synthetic@example.com" } });
            if (path === "/api/user/profile") return json({ onboardingComplete: true, displayName: "Synthetic", apiKeyStatus: {}, creditsRemaining: 100 });
            if (path === "/api/models/configured") return json({ models: [{ id: "test-model", label: "Test model", source: "Configured" }] });
            if (path.startsWith("/api/models/")) return json({ models: [] });
            if (path === "/api/user/google-actions") return json({ actions: [] });
            if (path === "/api/tabular-review/history-stress") return json({
                review: { id: "history-stress", title: "History stress", columns_config: [], model: "test-model", is_owner: true, access_role: "owner" },
                cells: [], rows: [], documents: [],
            });
            if (path === "/api/tabular-review/history-stress/chats") return json(["A", "B"].map((id) => ({
                id, title: `History ${id}`, model: "test-model", created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
            })));
            if (/\/chats\/[AB]\/messages$/.test(path)) return new Promise<Response>((resolve) => {
                pending.push({ id: path.split("/").at(-2)!, resolve });
                controls.pendingHistoryCount = pending.length;
            });
            return json([]);
        };
    });
    await page.goto("/tabular-reviews/history-stress?chat=A");
    await expect(page.getByRole("button", { name: "History A", exact: true })).toBeVisible();
    // Strict Mode can replay the initial load. Count those requests as well;
    // they must be retired just like later manual selections.
    const initialRequests = await page.evaluate(() => (window as Window & { pendingHistoryCount?: number }).pendingHistoryCount ?? 0);
    expect(initialRequests).toBeGreaterThan(0);
    for (let selection = 0; selection < 16; selection++) {
        await page.getByRole("button", { name: selection % 2 ? "History B" : "History A", exact: true }).click();
        await page.getByRole("menuitem", { name: selection % 2 ? /History A/ : /History B/ }).click();
    }
    await page.waitForFunction((expected) => (window as Window & { pendingHistoryCount?: number }).pendingHistoryCount === expected, initialRequests + 16);
    const latest = initialRequests + 15;
    await page.evaluate(() => (window as Window & { finishHistories?: () => Promise<void> }).finishHistories?.());
    await expect(page.getByText(`Selection ${latest}, answer 15`, { exact: false })).toBeVisible();
    await expect(page.getByText("Selection 0, answer 15", { exact: false })).toHaveCount(0);
    await page.setViewportSize({ width: 480, height: 720 });
    await expect(page.getByText(`Selection ${latest}, answer 15`, { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
});

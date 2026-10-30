import { test, expect } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

test("settings search focuses a heading after delayed navigation", async ({ page }) => {
    await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/auth/session") return route.fulfill({ json: { user: { id: "focus-test", email: "focus@example.test" } } });
        if (path === "/api/user/profile") return route.fulfill({ json: { onboardingComplete: true, displayName: "Focus test", apiKeyStatus: {}, creditsRemaining: 100 } });
        return route.fulfill({ json: [] });
    });
    // Install before mounting: a production prefetch must use the same gate.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === "/settings/security");
    await page.route(url => url.pathname === "/settings/security", async route => { await gate; await route.continue(); });
    await page.goto("/settings");
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await expect(search).toBeVisible();
    await page.clock.install();
    await search.fill("password");
    await search.press("Enter");
    await requested;
    // Reproduce the CI navigation that outlived the former three-second poll.
    // Virtual time keeps this deterministic without a wall-clock sleep.
    await page.clock.runFor(5_000);
    release();
    const heading = page.getByRole("heading", { name: "Password", exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
});

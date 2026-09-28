import { test, expect } from "@playwright/test";

// Exercise the actual settings page/popup/polling in Chromium while replacing
// the auth/profile and integration endpoints. No Google credentials or consent UI.
test("Google Drive connect, cancel and disconnect", async ({
    page,
    context,
}) => {
    await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/auth/session") return route.fulfill({ json: { user: { id: "fixture-user", email: "login@example.com" } } });
        if (path === "/api/user/profile") return route.fulfill({ json: { onboardingComplete: true, displayName: "Test user", apiKeyStatus: {}, creditsRemaining: 100 } });
        return route.fulfill({ json: [] });
    });
    let connected = false;
    let cancelled = false;
    const state = "a".repeat(32);
    await context.route("https://accounts.google.com/**", (route) =>
        route.fulfill({
            contentType: "text/html",
            body: "<p>Mock Google consent</p>",
        }),
    );
    // Other connected providers also render Disconnect buttons. Keep this
    // regression deterministic without depending on local Google grants.
    for (const provider of ["gmail", "google-calendar"]) {
        await page.route(`**/api/user/integrations/${provider}`, (route) =>
            route.fulfill({
                json: {
                    configured: true,
                    schemaReady: true,
                    connected: true,
                    writeEnabled: false,
                    accountEmail: "fixture@example.com",
                },
            }),
        );
    }
    await page.route("**/api/user/google-actions", (route) =>
        route.fulfill({ json: { actions: [] } }),
    );
    await page.route(
        "**/api/user/integrations/google-drive**",
        async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith("/oauth/start")) {
                return route.fulfill({
                    json: {
                        authorizationUrl: `https://accounts.google.com/authorize?state=${state}`,
                    },
                });
            }
            if (url.pathname.endsWith("/oauth/cancel")) {
                expect(route.request().postDataJSON()).toEqual({ state });
                cancelled = true;
                return route.fulfill({ status: 204 });
            }
            if (route.request().method() === "DELETE") {
                connected = false;
                return route.fulfill({ status: 204 });
            }
            return route.fulfill({
                json: {
                    connected,
                    scope: connected
                        ? "https://www.googleapis.com/auth/drive.readonly"
                        : null,
                    configured: true,
                    schemaReady: true,
                },
            });
        },
    );
    await page.goto("/settings/connectors");
    const drive = page.getByRole("region", { name: "Google Drive connector" });
    const connect = drive.getByRole("button", { name: "Add Google Drive", exact: true });
    await expect(connect).toBeEnabled();
    const firstPopup = context.waitForEvent("page");
    await connect.click();
    const popup = await firstPopup;
    await expect(popup).toHaveURL(/^https:\/\/accounts\.google\.com\//);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(drive.getByText("Waiting for Google…")).toBeVisible();
    await drive.getByRole("button", { name: "Cancel Google Drive authorization", exact: true }).click();
    await expect(drive.getByText("Authorization cancelled.")).toBeVisible();
    expect(cancelled).toBe(true);
    await expect(connect).toBeEnabled();
    if (!popup.isClosed()) await popup.close();

    await connect.click();
    connected = true; // Represents the successful server-side code exchange.
    await page.getByRole("button", { name: "Manage Google Drive" }).click();
    const details = page.getByRole("region", { name: "Google Drive connection" });
    const disconnect = details.getByRole("button", {
        name: "Disconnect",
        exact: true,
    });
    await expect(disconnect).toBeVisible();
    await disconnect.click();
    await expect(details.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    await page.getByRole("dialog", { name: "Google Drive", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
    await expect(connect).toBeEnabled();
    expect(connected).toBe(false);
});

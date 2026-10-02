import { test, expect } from "./fixtures";

// Exercise the actual settings page/popup/polling in Chromium while replacing
// the auth/profile and integration endpoints. No Google credentials or consent UI.
test("Google Drive add, cancel and delete work like Slack", async ({
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
    // Other connected providers also render Delete. Keep this regression
    // deterministic without depending on local Google grants.
    for (const provider of ["gmail", "google-calendar"]) {
        await page.route(`**/api/user/integrations/${provider}`, (route) =>
            route.fulfill({
                json: {
                    configured: true,
                    schemaReady: true,
                    connected: true,
                    writeEnabled: false,
                    enabled: true,
                    requireWriteApproval: false,
                    accountEmail: "fixture@example.com",
                    tools: [],
                },
            }),
        );
    }
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
                        ? "https://www.googleapis.com/auth/drive"
                        : null,
                    configured: true,
                    schemaReady: true,
                    enabled: true,
                    writeEnabled: connected,
                    requireWriteApproval: false,
                    tools: [
                        {
                            name: "google_drive_search",
                            title: "Search files",
                            description: "Search Drive.",
                            write: false,
                            enabled: true,
                        },
                    ],
                },
            });
        },
    );
    await page.goto("/settings/connectors");
    const discover = page.getByRole("region", { name: "Discover", exact: true });
    const installed = page.getByRole("region", { name: "Installed", exact: true });
    const drive = discover.getByRole("region", { name: "Google Drive connector" });
    const add = drive.getByRole("button", { name: "Add Google Drive connector", exact: true });
    await expect(add).toBeEnabled();
    const firstPopup = context.waitForEvent("page");
    await add.click();
    const popup = await firstPopup;
    await expect(popup).toHaveURL(/^https:\/\/accounts\.google\.com\//);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await drive.getByRole("button", { name: "Cancel Google Drive authorization", exact: true }).click();
    await expect(add).toBeEnabled();
    expect(cancelled).toBe(true);
    // A cancel is not a failure.
    await expect(page.getByText("Could not add connector")).toHaveCount(0);
    if (!popup.isClosed()) await popup.close();

    await add.click();
    connected = true; // Represents the successful server-side code exchange.
    await expect(drive.getByRole("button", { name: "Google Drive connector added" })).toBeDisabled();
    await installed.getByRole("button", { name: "Manage Google Drive" }).click();
    const dialog = page.getByRole("dialog", { name: "Google Drive", exact: true });
    await expect(dialog.getByText("Search files")).toBeVisible();
    const writeApproval = dialog.getByRole("switch", { name: "Ask for permission for write actions" });
    await expect(writeApproval).toBeVisible();
    await expect(writeApproval).toHaveAttribute("aria-checked", "false");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeEnabled();
    expect(connected).toBe(false);
});

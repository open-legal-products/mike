import { test, expect } from "@playwright/test";

// Exercise the real page with deterministic auth and Google endpoints. No
// live Google permissions, mail, or calendars are needed or changed.
test("Google SSO does not auto-connect Gmail; account choice, write upgrade and explicit approval", async ({
  page,
  context,
}) => {
  let connected = false;
  let writeEnabled = false;
  let grant = 0;
  let starts = 0;
  let approves = 0;
  let cancelled = 0;
  let actionStatus = "pending";
  const action = {
    id: "12345678-1234-1234-1234-123456789abc",
    provider: "gmail",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    resultMessage: null,
    proposal: {
      tool: "gmail_propose_send",
      accountEmail: "mail-test@example.com",
      args: {
        to: ["recipient@example.com"],
        subject: "Fixture approval",
        body: "Only send this after approval.",
      },
    },
  };
  await context.route("https://accounts.google.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Test account chooser and consent</p>",
    }),
  );
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          user: {
            id: "fixture-user",
            email: "sso-login@example.com",
            createdWithGoogle: true,
            pendingEmail: null,
          },
        },
      });
    if (path === "/api/user/profile")
      return route.fulfill({
        json: {
          onboardingComplete: true,
          displayName: "Test user",
          apiKeyStatus: {},
          creditsRemaining: 100,
        },
      });
    if (path === "/api/user/mcp-connectors")
      return route.fulfill({ json: [] });
    if (path === "/api/user/google-actions")
      return route.fulfill({
        json: {
          actions:
            connected && writeEnabled
              ? [{ ...action, status: actionStatus }]
              : [],
        },
      });
    if (path.endsWith("/approve")) {
      approves++;
      expect(req.method()).toBe("POST");
      expect(req.postData()).toBeNull();
      actionStatus = "succeeded";
      return route.fulfill({
        json: {
          status: "succeeded",
          message: "Google confirmed this action completed.",
        },
      });
    }
    if (path.includes("/integrations/")) {
      if (path.endsWith("/oauth/start")) {
        starts++;
        const body = req.postDataJSON();
        expect(body).toEqual({ write: starts === 2 });
        return route.fulfill({
          json: {
            authorizationUrl:
              "https://accounts.google.com/auth?state=" + "a".repeat(32),
          },
        });
      }
      if (path.endsWith("/oauth/cancel")) {
        cancelled++;
        return route.fulfill({ status: 204 });
      }
      if (req.method() === "DELETE") {
        connected = false;
        writeEnabled = false;
        return route.fulfill({ status: 204 });
      }
      const gmail = path.endsWith("/gmail");
      return route.fulfill({
        json: {
          configured: true,
          schemaReady: true,
          connected: gmail && connected,
          writeEnabled: gmail && writeEnabled,
          grantId: gmail && connected ? String(grant) : undefined,
          accountEmail:
            gmail && connected ? "mail-test@example.com" : undefined,
          redirectUri:
            "http://localhost:3000/api/user/integrations/gmail/oauth/callback",
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/settings/connectors");
  const discover = page.getByRole("region", { name: "Discover", exact: true });
  await expect(discover.getByRole("button", { name: "Add Gmail", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Google accounts", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(starts).toBe(0);
  expect(approves).toBe(0);
  const popupPromise = context.waitForEvent("page");
  await discover.getByRole("button", { name: "Add Gmail", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(discover.getByText("Waiting for Google…")).toBeVisible();
  connected = true;
  grant++;
  await page.getByRole("button", { name: "Manage Gmail", exact: true }).click();
  const gmail = page.getByRole("region", { name: "Gmail connection" });
  await expect(page.getByRole("dialog", { name: "Gmail", exact: true }).getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await expect(
    gmail.getByText(/Connected as mail-test@example.com.*Read-only/),
  ).toBeVisible();
  await gmail
    .getByRole("button", { name: "Enable writes with approval" })
    .click();
  await expect(gmail.getByText("Waiting for Google…")).toBeVisible();
  // Existing read access must not finish the upgrade.
  await expect(gmail.getByText(/Read-only/)).toBeVisible();
  writeEnabled = true;
  grant++;
  await expect(gmail.getByText(/Writes require approval/)).toBeVisible();
  await page.getByRole("dialog", { name: "Gmail", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Recent Google actions" }).click();
  await expect(page.getByText("Only send this after approval.")).toBeVisible();
  expect(approves).toBe(0);
  await page.getByRole("button", { name: "Approve send email" }).click();
  await expect(page.getByText("Status: succeeded")).toBeVisible();
  expect(approves).toBe(1);
  expect(cancelled).toBe(0);
  await page.getByRole("button", { name: "Manage Gmail" }).click();
  await gmail.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(gmail.getByText("Not connected", { exact: true })).toBeVisible();
});

test("Calendar Add opens Google account selection directly with read-only access", async ({ page, context }) => {
  let starts = 0;
  let cancellations = 0;
  await context.route("https://accounts.google.com/**", route => route.fulfill({ contentType: "text/html", body: "<p>Test OAuth destination</p>" }));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") return route.fulfill({ json: { user: { id: "calendar-user", email: "login@example.com", createdWithGoogle: true } } });
    if (path === "/api/user/profile") return route.fulfill({ json: { onboardingComplete: true, displayName: "Test user", apiKeyStatus: {}, creditsRemaining: 100 } });
    if (path === "/api/user/google-actions") return route.fulfill({ json: { actions: [] } });
    if (path.endsWith("/google-calendar/oauth/start")) {
      starts++;
      expect(route.request().postDataJSON()).toEqual({ write: false });
      return route.fulfill({ json: { authorizationUrl: "https://accounts.google.com/auth?state=" + "c".repeat(32) } });
    }
    if (path.endsWith("/google-calendar/oauth/cancel")) {
      cancellations++;
      return route.fulfill({ status: 204 });
    }
    if (path.includes("/integrations/")) return route.fulfill({ json: { configured: true, schemaReady: true, connected: false, writeEnabled: false } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/settings/connectors");
  const add = page.getByRole("region", { name: "Discover", exact: true }).getByRole("button", { name: "Add Google Calendar", exact: true });
  await expect(add).toBeEnabled();
  expect(starts).toBe(0);
  const popupPromise = context.waitForEvent("page");
  await add.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel Google Calendar authorization", exact: true }).click();
  await expect(add).toBeEnabled();
  expect(starts).toBe(1);
  expect(cancellations).toBe(1);
});

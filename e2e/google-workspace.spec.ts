import { test, expect } from "./fixtures";

const gmailTools = [
  {
    name: "gmail_search",
    title: "Search email",
    description: "Search email.",
    write: false,
    enabled: true,
  },
  {
    name: "gmail_send",
    title: "Send email",
    description: "Send a new plain-text email.",
    write: true,
    enabled: true,
  },
];

// Exercise the real page with deterministic auth and Google endpoints. No
// live Google permissions, mail, or calendars are needed or changed.
test("Google SSO does not auto-connect Gmail; Add asks Google for access and Manage matches Slack", async ({
  page,
  context,
}) => {
  let connected = false;
  let grant = 0;
  let starts = 0;
  let cancelled = 0;
  let requireWriteApproval = false;
  let sendEnabled = true;
  const patches: { path: string; body: unknown }[] = [];
  const legacyRequests: string[] = [];
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
    if (path.startsWith("/api/user/google-actions")) {
      legacyRequests.push(path);
      return route.fulfill({ status: 404, json: {} });
    }
    if (path.includes("/integrations/")) {
      if (path.endsWith("/oauth/start")) {
        starts++;
        // The browser cannot choose narrower permissions; the server asks
        // Google for read and write access on every connect.
        expect(req.postData() ?? "").toBe("");
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
        return route.fulfill({ status: 204 });
      }
      if (req.method() === "PATCH") {
        const body = req.postDataJSON();
        patches.push({ path, body });
        if (path.endsWith("/tools/gmail_send")) sendEnabled = body.enabled;
        else requireWriteApproval = body.requireWriteApproval;
      }
      const gmail = path.startsWith("/api/user/integrations/gmail");
      return route.fulfill({
        json: {
          configured: true,
          schemaReady: true,
          connected: gmail && connected,
          writeEnabled: gmail && connected,
          enabled: true,
          requireWriteApproval,
          grantId: gmail && connected ? String(grant) : undefined,
          accountEmail:
            gmail && connected ? "mail-test@example.com" : undefined,
          redirectUri:
            "http://localhost:3000/api/user/integrations/gmail/oauth/callback",
          tools: gmailTools.map((tool) =>
            tool.name === "gmail_send"
              ? { ...tool, enabled: sendEnabled }
              : tool,
          ),
        },
      });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/settings/connectors");
  const discover = page.getByRole("region", { name: "Discover", exact: true });
  const installed = page.getByRole("region", { name: "Installed", exact: true });
  const add = discover.getByRole("button", {
    name: "Add Gmail connector",
    exact: true,
  });
  await expect(add).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Recent Google actions")).toHaveCount(0);
  expect(starts).toBe(0);

  const popupPromise = context.waitForEvent("page");
  await add.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    discover.getByRole("button", { name: "Cancel Gmail authorization" }),
  ).toBeEnabled();
  connected = true;
  grant++;

  // Like Slack: the Discover card stays, marked Added, and an installed card
  // with an on/off switch appears.
  await expect(
    discover.getByRole("button", { name: "Gmail connector added" }),
  ).toBeDisabled();
  await expect(
    installed.getByRole("switch", { name: "Gmail connector", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await installed
    .getByRole("button", { name: "Manage Gmail", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Gmail", exact: true });
  await expect(
    dialog.getByText("mail-test@example.com", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("2 Tools")).toBeVisible();

  const approval = dialog.getByRole("switch", {
    name: "Ask for permission for write actions",
  });
  await expect(approval).toHaveAttribute("aria-checked", "false");
  await approval.click();
  await expect(approval).toHaveAttribute("aria-checked", "true");
  const send = dialog.getByRole("switch", { name: "Send email enabled" });
  await send.click();
  await expect(send).toHaveAttribute("aria-checked", "false");
  expect(patches).toEqual([
    {
      path: "/api/user/integrations/gmail",
      body: { requireWriteApproval: true },
    },
    {
      path: "/api/user/integrations/gmail/tools/gmail_send",
      body: { enabled: false },
    },
  ]);

  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(add).toBeEnabled();
  await expect(
    installed.getByRole("button", { name: "Manage Gmail", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(cancelled).toBe(0);
  expect(legacyRequests).toEqual([]);
});

test("Calendar Add opens Google account selection directly and can be cancelled", async ({
  page,
  context,
}) => {
  let starts = 0;
  let cancellations = 0;
  await context.route("https://accounts.google.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Test OAuth destination</p>",
    }),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({
        json: {
          user: {
            id: "calendar-user",
            email: "login@example.com",
            createdWithGoogle: true,
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
    if (path.endsWith("/google-calendar/oauth/start")) {
      starts++;
      return route.fulfill({
        json: {
          authorizationUrl:
            "https://accounts.google.com/auth?state=" + "c".repeat(32),
        },
      });
    }
    if (path.endsWith("/google-calendar/oauth/cancel")) {
      cancellations++;
      return route.fulfill({ status: 204 });
    }
    if (path.includes("/integrations/"))
      return route.fulfill({
        json: {
          configured: true,
          schemaReady: true,
          connected: false,
          writeEnabled: false,
          enabled: true,
          requireWriteApproval: false,
          tools: [],
        },
      });
    return route.fulfill({ json: [] });
  });
  await page.goto("/settings/connectors");
  const add = page
    .getByRole("region", { name: "Discover", exact: true })
    .getByRole("button", { name: "Add Google Calendar connector", exact: true });
  await expect(add).toBeEnabled();
  expect(starts).toBe(0);
  const popupPromise = context.waitForEvent("page");
  await add.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/^https:\/\/accounts\.google\.com\//);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Cancel Google Calendar authorization",
      exact: true,
    })
    .click();
  await expect(add).toBeEnabled();
  await expect(page.getByText("Could not add connector")).toHaveCount(0);
  expect(starts).toBe(1);
  expect(cancellations).toBe(1);
});

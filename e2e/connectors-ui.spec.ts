import { test, expect, type BrowserContext } from "@playwright/test";

// Exercise the real settings screen and popup navigation without external
// accounts or a backend. Each test owns its synthetic connection state.
test.use({ storageState: { cookies: [], origins: [] } });

const providers = [
  ["google-drive", "Google Drive"],
  ["gmail", "Gmail"],
  ["google-calendar", "Google Calendar"],
  ["slack", "Slack"],
] as const;

async function mockConnectors(
  context: BrowserContext,
  options: {
    configured?: boolean;
    dark?: boolean;
    connected?: boolean;
    email?: string;
    failStart?: boolean;
  } = {},
) {
  const connected = new Set(
    options.connected ? providers.map(([id]) => id) : [],
  );
  const calls: string[] = [];
  const summary = () => ({
    id: "slack-test",
    name: "Slack",
    serverUrl: "https://mcp.slack.com/mcp",
    transport: "streamable_http",
    authType: "oauth",
    enabled: true,
    hasAuthConfig: false,
    oauthConnected: connected.has("slack"),
    customHeaderKeys: [],
    toolPolicy: {},
    tools: [],
    toolCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "connector-consent.invalid") {
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Test provider consent</h1>",
      });
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4);
    calls.push(`${request.method()} ${path}`);
    let body: unknown = [];
    if (path === "/auth/session")
      body = { user: { id: "synthetic-user", email: "test@example.com" } };
    else if (path === "/user/profile")
      body = {
        onboardingComplete: true,
        displayName: "Test user",
        darkMode: options.dark ?? false,
        apiKeyStatus: {},
        practiceAreas: [],
        openRouterModels: [],
        vercelModels: [],
        openCodeGoModels: [],
      };
    else if (path === "/auth/mfa/assurance")
      body = { currentLevel: "aal1", nextLevel: "aal1" };
    else if (path === "/auth/mfa/factors") body = { all: [], totp: [] };
    else if (path === "/user/google-actions") body = { actions: [] };
    else if (
      /^\/user\/integrations\/(google-drive|gmail|google-calendar)$/.test(path)
    ) {
      const provider = path.split("/").at(-1)! as (typeof providers)[number][0];
      if (request.method() === "DELETE") connected.delete(provider);
      body = {
        configured: options.configured ?? true,
        schemaReady: true,
        connected: connected.has(provider),
        writeEnabled: false,
        accountEmail: options.email ?? "alex.morgan@example.com",
        grantId: connected.has(provider) ? "synthetic-grant" : null,
        redirectUri: `${url.origin}/api/user/integrations/${provider}/oauth/callback`,
      };
    } else if (path.endsWith("/oauth/start")) {
      if (options.failStart)
        return route.fulfill({
          status: 500,
          json: { detail: "internal-sentinel" },
        });
      body = {
        authorizationUrl:
          "https://connector-consent.invalid/authorize?state=synthetic-state",
        alreadyAuthorized: false,
        callbackOrigin: url.origin,
      };
    } else if (path === "/user/mcp-connectors") {
      body =
        request.method() === "POST"
          ? { connector: summary(), oauthRequired: true }
          : connected.has("slack")
            ? [summary()]
            : [];
    } else if (path.startsWith("/user/mcp-connectors/")) {
      if (request.method() === "DELETE") connected.delete("slack");
      body = summary();
    }
    return route.fulfill({ json: body });
  });
  return { connected, calls };
}

for (const [provider, name] of providers) {
  test(`${name}: one-click consent, quiet cancellation, retry and Manage`, async ({
    page,
    context,
  }) => {
    const state = await mockConnectors(context);
    await page.goto("/settings/connectors");
    const card = page.getByRole("region", {
      name: `${name} connector`,
      exact: true,
    });
    await expect(
      card.getByRole("button", { name: `Add ${name}`, exact: true }),
    ).toBeEnabled();
    await expect(
      card.getByText("Not connected", { exact: true }),
    ).toBeVisible();
    const opened = page.waitForEvent("popup");
    await card
      .getByRole("button", { name: `Add ${name}`, exact: true })
      .click();
    const popup = await opened;
    await expect(popup).toHaveURL(/connector-consent\.invalid\/authorize/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: `Cancel ${name} authorization` }),
    ).toBeEnabled();
    await expect(card.getByRole("status")).toHaveText(`Waiting for ${name}…`);
    await expect(
      card.getByRole("button", { name: /Manage|Added/ }),
    ).toHaveCount(0);
    await card
      .getByRole("button", { name: `Cancel ${name} authorization` })
      .click();
    await expect(
      card.getByRole("button", { name: `Add ${name}`, exact: true }),
    ).toBeEnabled();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect(card.getByRole("alert")).toHaveCount(0);
    expect(state.calls).toContain(
      provider === "slack"
        ? "DELETE /user/mcp-connectors/slack-test"
        : `POST /user/integrations/${provider}/oauth/cancel`,
    );
    const retried = page.waitForEvent("popup");
    await card
      .getByRole("button", { name: `Add ${name}`, exact: true })
      .click();
    const consent = await retried;
    await expect(consent).toHaveURL(/connector-consent\.invalid/);
    state.connected.add(provider);
    await expect(
      card.getByRole("button", { name: `Manage ${name}` }),
    ).toBeEnabled();
    await expect.poll(() => consent.isClosed()).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await card.getByRole("button", { name: `Manage ${name}` }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test(`${name}: failed start stays on the card and allows retry`, async ({
    page,
    context,
  }) => {
    await mockConnectors(context, { failStart: true });
    await page.goto("/settings/connectors");
    const card = page.getByRole("region", {
      name: `${name} connector`,
      exact: true,
    });
    await card
      .getByRole("button", { name: `Add ${name}`, exact: true })
      .click();
    await expect(card.getByRole("alert")).toBeVisible();
    await expect(card.getByRole("alert")).not.toContainText(
      "internal-sentinel",
    );
    await expect(
      card.getByRole("button", { name: `Add ${name}`, exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => context.pages().length).toBe(1);
  });

  test(`${name}: blocked popup navigates directly to consent`, async ({
    page,
    context,
  }) => {
    await mockConnectors(context);
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.goto("/settings/connectors");
    await page
      .getByRole("button", { name: `Add ${name}`, exact: true })
      .click();
    await expect(page).toHaveURL(/connector-consent\.invalid\/authorize/);
  });
}

for (const width of [375, 768, 1440]) {
  for (const dark of [false, true]) {
    test(`cards fit ${width}px in ${dark ? "dark" : "light"} mode with normal and long accounts`, async ({
      page,
      context,
    }, testInfo) => {
      for (const [label, email] of [
        ["normal", "alex.morgan@example.com"],
        [
          "long",
          "alex.morgan.with.an.unusually.long.account.identifier@an-unusually-long-company-domain.example.com",
        ],
      ]) {
        await page.setViewportSize({ width, height: 1000 });
        await mockConnectors(context, { connected: true, email, dark });
        await page.goto("/settings/connectors");
        await expect(
          page.getByRole("button", { name: "Manage Gmail" }),
        ).toBeEnabled();
        for (const [, name] of providers) {
          const card = page.getByRole("region", {
            name: `${name} connector`,
            exact: true,
          });
          await expect(
            card.getByRole("button", { name: `Manage ${name}` }),
          ).toBeEnabled();
          const overflows = await card.evaluate((element) =>
            [element, ...element.querySelectorAll("p,button")].some(
              (node) => node.scrollWidth > node.clientWidth + 1,
            ),
          );
          expect(overflows).toBe(false);
        }
        for (const name of ["Gmail", "Google Calendar"]) {
          const card = page.getByRole("region", {
            name: `${name} connector`,
            exact: true,
          });
          await expect(card.getByText(email, { exact: true })).toBeVisible();
          await expect(
            card.getByText("Read-only", { exact: true }),
          ).toBeVisible();
        }
        await page
          .getByRole("region", { name: "Discover", exact: true })
          .screenshot({ path: testInfo.outputPath(`${label}-accounts.png`) });
        await testInfo.attach(`${label} accounts`, {
          path: testInfo.outputPath(`${label}-accounts.png`),
          contentType: "image/png",
        });
      }
    });
  }
}

test("unconfigured Google connectors explain availability inline", async ({
  page,
  context,
}) => {
  await mockConnectors(context, { configured: false });
  await page.goto("/settings/connectors");
  for (const [, name] of providers.filter(([id]) => id !== "slack")) {
    const card = page.getByRole("region", {
      name: `${name} connector`,
      exact: true,
    });
    await expect(
      card.getByRole("button", { name: `Add ${name}`, exact: true }),
    ).toBeDisabled();
    await expect(
      card.getByText(/configure a Google OAuth client/),
    ).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /Set up/ })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

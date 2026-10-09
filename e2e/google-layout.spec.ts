import { test, expect } from "./fixtures";

for (const width of [390, 1280]) {
  test(`Google setup warnings match Slack's and Discover cards fit ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let oauthStarts = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/session") return route.fulfill({ json: { user: { id: "setup-user", email: "login@example.com" } } });
      if (path === "/api/user/profile") return route.fulfill({ json: { onboardingComplete: true, displayName: "Setup test", apiKeyStatus: {}, creditsRemaining: 100 } });
      if (path.endsWith("/oauth/start")) {
        oauthStarts++;
        const provider = path.split("/").at(-3);
        return route.fulfill({
          status: 400,
          json: {
            code: "connector_setup_required",
            detail: `${provider} needs an OAuth client. Create one in Google Cloud Console with authorized redirect URI https://mike.example.com/api/user/integrations/${provider}/oauth/callback, then set the client ID and secret in backend/.env and restart.`,
          },
        });
      }
      if (path.includes("/integrations/")) return route.fulfill({ json: {
        configured: false, schemaReady: true, connected: false, writeEnabled: false,
        enabled: true, requireWriteApproval: false, tools: [],
        redirectUri: `https://mike.example.com/api/user/integrations/${path.split("/").pop()}/oauth/callback`,
      } });
      return route.fulfill({ json: [] });
    });
    await page.goto("/settings/connectors");
    const discover = page.getByRole("region", { name: "Discover", exact: true });
    const slack = discover.getByRole("region", { name: "Slack connector", exact: true });
    await expect(slack.getByRole("button", { name: "Add Slack connector" })).toBeEnabled();
    const slackHeight = await slack.evaluate((element) => element.getBoundingClientRect().height);
    for (const name of ["Google Drive", "Gmail", "Google Calendar"]) {
      const card = discover.getByRole("region", { name: `${name} connector`, exact: true });
      const add = card.getByRole("button", { name: `Add ${name} connector`, exact: true });
      await expect(add).toBeEnabled();
      expect(await card.evaluate((element) => element.getBoundingClientRect().height)).toBe(slackHeight);
      await add.click();
      const warning = page.getByRole("alert").filter({ hasText: "Could not add connector" });
      await expect(warning).toContainText("needs an OAuth client");
      await expect(warning.getByRole("link", { name: "Open connector setup guide" })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const bounds = await warning.evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        overflow: element.scrollWidth - element.clientWidth,
      }));
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      expect(bounds.overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`${name}-setup.png`), animations: "disabled" });
      await warning.getByRole("button", { name: "Dismiss warning" }).click();
      await expect(add).toBeEnabled();
    }
    expect(oauthStarts).toBe(3);
    await expect(page.getByRole("region", { name: "Installed", exact: true }).getByText("No connectors yet.")).toBeVisible();
  });
}

// Real browser layout, deterministic synthetic provider data. This does not
// grant Google access or establish live provider acceptance.
for (const addressKind of ["normal", "long"] as const) {
  for (const { width, darkMode } of [
    { width: 390, darkMode: false },
    { width: 768, darkMode: false },
    { width: 1280, darkMode: false },
    { width: 390, darkMode: true },
    { width: 1280, darkMode: true },
  ]) {
    test(`Google connections fit ${width}px in ${darkMode ? "dark" : "light"} mode with ${addressKind} email`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 700 : 900 });
      const accountEmail = addressKind === "normal"
        ? "alex.morgan@example.com"
        : `connector.acceptance+${"x".repeat(40)}@example.com`;
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/auth/session")
          return route.fulfill({
            json: {
              user: {
                id: "layout-user",
                email: "login@example.com",
                createdWithGoogle: true,
              },
            },
          });
        if (path === "/api/user/profile")
          return route.fulfill({
            json: {
              onboardingComplete: true,
              darkMode,
              displayName: "Layout test",
              apiKeyStatus: {},
              creditsRemaining: 100,
            },
          });
        if (path.includes("/user/integrations/"))
          return route.fulfill({
            json: {
              configured: true,
              schemaReady: true,
              connected: true,
              enabled: true,
              writeEnabled: true,
              requireWriteApproval: true,
              accountEmail,
              tools: [
                {
                  name: "search",
                  title: "Search",
                  description: "x".repeat(200),
                  write: false,
                  enabled: true,
                },
                {
                  name: "send",
                  title: "A deliberately long action title that must wrap rather than clip",
                  description: "Changes data.",
                  write: true,
                  enabled: false,
                },
              ],
            },
          });
        return route.fulfill({ json: [] });
      });
      await page.goto("/settings/connectors");
      const installed = page.getByRole("region", { name: "Installed", exact: true });
      await expect(installed.getByRole("button", { name: "Manage Gmail", exact: true })).toBeEnabled();
      await expect(page.getByText("Recent Google actions")).toHaveCount(0);
      for (const name of ["Google Drive", "Gmail", "Google Calendar"]) {
        await expect(installed.getByRole("region", { name: `${name} connector`, exact: true })).toBeVisible();
        await expect(installed.getByRole("switch", { name: `${name} connector`, exact: true })).toHaveAttribute("aria-checked", "true");
      }
      for (const provider of ["google-drive", "gmail", "google-calendar"]) {
        const logo = installed.locator(`img[src="/icons/integrations/${provider}.png"]`);
        await expect(logo).toBeVisible();
        await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      }
      // Installed and Discover share one card component, so they match.
      const heightOf = (region: ReturnType<typeof installed.getByRole>) =>
        region.evaluate((element) => element.getBoundingClientRect().height);
      const discoverHeight = await heightOf(
        page
          .getByRole("region", { name: "Discover", exact: true })
          .getByRole("region", { name: "Slack connector", exact: true }),
      );
      for (const name of ["Google Drive", "Gmail", "Google Calendar"]) {
        expect(
          await heightOf(installed.getByRole("region", { name: `${name} connector`, exact: true })),
          `${name} installed card height`,
        ).toBe(discoverHeight);
      }
      await installed.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("google-cards.png"), fullPage: true, animations: "disabled" });
      for (const region of [
        ...["Google Drive", "Gmail", "Google Calendar"].map((name) =>
          installed.getByRole("region", { name: `${name} connector`, exact: true }),
        ),
        page.getByRole("region", { name: "Discover", exact: true }),
      ]) {
        const size = await region.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            overflow: element.scrollWidth - element.clientWidth,
          };
        });
        expect(size.left).toBeGreaterThanOrEqual(0);
        expect(size.right).toBeLessThanOrEqual(width);
        expect(
          size.overflow,
          `${await region.getAttribute("aria-label")} content overflow`,
        ).toBeLessThanOrEqual(1);
      }
      for (const name of ["Google Drive", "Gmail", "Google Calendar"]) {
        await installed.getByRole("button", { name: `Manage ${name}`, exact: true }).click();
        const dialog = page.getByRole("dialog", { name, exact: true });
        await expect(dialog).toBeVisible();
        const bounds = await dialog.evaluate((element) => ({
          left: element.getBoundingClientRect().left,
          right: element.getBoundingClientRect().right,
          overflow: element.scrollWidth - element.clientWidth,
        }));
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(width);
        expect(bounds.overflow).toBeLessThanOrEqual(1);
        await page.screenshot({ path: testInfo.outputPath(`${name.toLowerCase().replaceAll(" ", "-")}-details.png`), animations: "disabled" });
        await expect(dialog.getByText(accountEmail, { exact: true })).toBeVisible();
        await expect(
          dialog.getByRole("switch", { name: "Ask for permission for write actions" }),
        ).toHaveAttribute("aria-checked", "true");
        for (const text of await dialog.locator("p").all()) {
          const overflow = await text.evaluate((element) => ({
            horizontal: element.scrollWidth - element.clientWidth,
            vertical: element.scrollHeight - element.clientHeight,
          }));
          expect(overflow.horizontal, `${name} text must not be clipped`).toBeLessThanOrEqual(1);
          expect(overflow.vertical, `${name} text must fit vertically`).toBeLessThanOrEqual(1);
        }
        if (addressKind === "normal") {
          const emailSize = await dialog.getByText(accountEmail, { exact: true }).evaluate((element) => ({
            height: element.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
          }));
          expect(emailSize.height, `${name} normal email should fit one line`).toBeLessThanOrEqual(emailSize.lineHeight + 1);
        }
        await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeInViewport();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await expect(installed.getByRole("button", { name: `Manage ${name}`, exact: true })).toBeFocused();
      }
    });
  }
}

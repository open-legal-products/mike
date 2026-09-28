import { test, expect } from "@playwright/test";

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
      const action = {
        id: "12345678-1234-1234-1234-123456789abc",
        provider: "gmail",
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        resultMessage: null,
        proposal: {
          tool: "gmail_propose_send",
          accountEmail,
          args: {
            to: [accountEmail],
            subject: "Synthetic review",
            body: "x".repeat(300),
          },
        },
      };
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
        if (path === "/api/user/google-actions")
          return route.fulfill({ json: { actions: [action] } });
        if (path.includes("/user/integrations/"))
          return route.fulfill({
            json: {
              configured: true,
              schemaReady: true,
              connected: true,
              writeEnabled: true,
              accountEmail,
            },
          });
        return route.fulfill({ json: [] });
      });
      await page.goto("/settings/connectors");
      await expect(page.getByRole("button", { name: "Manage Gmail", exact: true })).toBeEnabled();
      await expect(page.getByRole("heading", { name: "Google accounts", exact: true })).toHaveCount(0);
      for (const name of ["Google Drive", "Gmail", "Google Calendar"]) {
        await expect(page.getByRole("region", { name: "Discover", exact: true }).getByRole("region", { name: `${name} connector`, exact: true })).toBeVisible();
      }
      for (const provider of ["google-drive", "gmail", "google-calendar"]) {
        const logo = page.locator(`img[src="/icons/integrations/${provider}.png"]`);
        await expect(logo).toBeVisible();
        await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      }
      for (const name of ["Gmail", "Google Calendar"]) {
        const card = page.getByRole("region", { name: `${name} connector`, exact: true });
        await expect(card.getByText(accountEmail, { exact: true })).toBeVisible();
        await expect(card.getByText("Writes require approval", { exact: true })).toBeVisible();
        if (addressKind === "normal") {
          const emailSize = await card.getByText(accountEmail, { exact: true }).evaluate((element) => ({
            height: element.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
          }));
          expect(emailSize.height, `${name} normal email should fit one line`).toBeLessThanOrEqual(emailSize.lineHeight + 1);
        }
        for (const text of await card.locator("p").all()) {
          const overflow = await text.evaluate((element) => ({
            horizontal: element.scrollWidth - element.clientWidth,
            vertical: element.scrollHeight - element.clientHeight,
          }));
          expect(overflow.horizontal, `${name} text must not be clipped`).toBeLessThanOrEqual(1);
          expect(overflow.vertical, `${name} text must fit vertically`).toBeLessThanOrEqual(1);
        }
      }
      await expect(page.getByRole("article", { name: "Send email approval" })).toBeHidden();
      await page.getByRole("region", { name: "Discover", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("google-cards.png"), fullPage: true, animations: "disabled" });
      await page.locator("summary").filter({ hasText: "Recent Google actions" }).click();
      const approval = page.getByRole("article", { name: "Send email approval" });
      await expect(approval).toBeVisible();
      for (const card of [
        page.getByRole("region", {
          name: "Google Drive connector",
          exact: true,
        }),
        page.getByRole("region", { name: "Gmail connector", exact: true }),
        page.getByRole("region", {
          name: "Google Calendar connector",
          exact: true,
        }),
        approval,
        page.getByRole("region", { name: "Discover", exact: true }),
      ]) {
        const size = await card.evaluate((element) => {
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
          `${await card.getAttribute("aria-label")} content overflow`,
        ).toBeLessThanOrEqual(1);
      }
      for (const name of ["Google Drive", "Gmail", "Google Calendar"]) {
        await page.getByRole("button", { name: `Manage ${name}`, exact: true }).click();
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
        if (name === "Gmail") {
          await expect(dialog.getByRole("button", { name: "Disconnect", exact: true })).toBeInViewport();
        }
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.getByRole("button", { name: `Manage ${name}`, exact: true })).toBeFocused();
      }
      await expect(
        approval.getByRole("button", { name: "Approve send email" }),
      ).toBeEnabled();
      await expect(
        approval.getByRole("button", { name: "Reject", exact: true }),
      ).toBeEnabled();
    });
  }
}

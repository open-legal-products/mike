import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

const TOKEN = "greeting-test-token";
const ORG = "11111111-1111-4111-8111-111111111111";

/**
 * The greeting's icon ends up to the left of "Hi, {name}", not on top of it.
 * The offset is measured from the greeting's width, so a greeting mounted
 * while the Assistant view is hidden must still measure once it shows.
 */
async function expectIconBesideGreeting(page: Page): Promise<void> {
  const icon = page.getByTestId("initial-mike-icon");
  const greeting = page.getByRole("heading", { name: /^Hi, / });
  await expect(greeting).toBeVisible();
  await expect
    .poll(async () => {
      const [iconBox, textBox] = await Promise.all([
        icon.boundingBox(),
        greeting.boundingBox(),
      ]);
      if (!iconBox || !textBox) return false;
      return iconBox.x + iconBox.width <= textBox.x + 1;
    }, { timeout: 5_000 })
    .toBe(true);
}

async function openSection(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name }).click();
}

test("the greeting lays out after a storage change made in Settings", async ({
  addin,
  page,
}) => {
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await expectIconBesideGreeting(page);

  await openSection(page, "Settings");
  await page.getByRole("switch", { name: "Save chats in the cloud" }).click();
  await openSection(page, "Assistant");

  await expectIconBesideGreeting(page);
});

test("the greeting lays out after a workspace switch made in Settings", async ({
  addin,
  page,
}) => {
  await page.route("**/orgs", (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: ORG, name: "Firm LLP", role: "member" }]),
    });
  });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  await openSection(page, "Settings");
  await page.getByRole("button", { name: "Workspace" }).click();
  await page.getByRole("menuitem", { name: "Firm LLP" }).click();
  await openSection(page, "Assistant");

  await expectIconBesideGreeting(page);
});

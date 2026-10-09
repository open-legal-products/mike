/** Real chat persistence and sidebar mutations, with only the provider replaced. */
import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures";
import { hasLlmKey, LLM_SKIP_REASON } from "./llm";
import { selectClaudeModel, expectSavedAnswer } from "./helpers";

test("chat lifecycle: answer survives reload, rename and delete persist", async ({ page }) => {
    test.skip(!hasLlmKey, LLM_SKIP_REASON);
    test.setTimeout(120_000);
    const reply = `Chat round trip ${randomUUID()}`;
    const title = `Renamed ${randomUUID()}`;

    await page.goto("/assistant");
    await selectClaudeModel(page);
    await page.getByPlaceholder("How can I help?").fill(`Reply with exactly: ${reply}`);
    await page.getByPlaceholder("How can I help?").press("Enter");
    await expect(page).toHaveURL(/\/assistant\/chat\/[^/]+$/);
    const chatUrl = page.url();
    const chatId = new URL(chatUrl).pathname.split("/").at(-1);
    await expectSavedAnswer(page, reply);

    const openSidebar = page.getByTitle("Open sidebar").first();
    if (await openSidebar.isVisible()) await openSidebar.click();
    // The just-created chat is first. Once renamed, use its unique title.
    const row = page.locator("div.group.relative.h-8.rounded-md").first();
    await row.hover();
    await row.locator("button").last().click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByLabel("Chat title").fill(title);
    const renamed = page.waitForResponse(r =>
        new URL(r.url()).pathname === `/api/chat/${chatId}` && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await renamed).ok()).toBe(true);
    await page.reload();
    const titleButton = page.getByRole("button", { name: title, exact: true });
    await expect(titleButton).toBeVisible();

    const renamedRow = page.locator("div.group.relative.h-8.rounded-md").filter({ has: titleButton });
    await renamedRow.hover();
    await renamedRow.locator("button").last().click();
    const deleted = page.waitForResponse(r =>
        new URL(r.url()).pathname === `/api/chat/${chatId}` && r.request().method() === "DELETE",
    );
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    expect((await deleted).ok()).toBe(true);

    // A fresh load must reject the deleted chat, not merely hide an optimistic row.
    const missing = page.waitForResponse(r =>
        new URL(r.url()).pathname === `/api/chat/${chatId}` && r.request().method() === "GET",
    );
    await page.goto(chatUrl);
    expect((await missing).status()).toBe(404);
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(titleButton).toBeHidden();
});

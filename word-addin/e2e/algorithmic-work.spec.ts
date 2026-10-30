import { test, expect } from "./support/fixtures";
import { replacementEdit, wordEdits } from "./support/editProtocol";

test("bulk acceptance loads one revision inventory for twenty distinct edits", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  const originals = Array.from({ length: 20 }, (_, i) => `Original clause ${String(i).padStart(2, "0")}`);
  await addin.mockChatStream([wordEdits(...originals.map((original, i) => replacementEdit(original, `Revised clause ${i}`, "Clarify wording.")))]);
  await addin.gotoTaskpane({ documentText: originals.join(".\n") });
  await addin.expectAuthedShell();
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
  await page.getByPlaceholder("How can I help?").fill("Clarify every clause");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(20);
  const before = (await addin.wordCalls()).bodyRevisionReads;
  await page.getByRole("button", { name: "Accept all", exact: true }).click();
  await expect.poll(async () => (await addin.wordCalls()).acceptedChanges.length).toBe(20);
  expect((await addin.wordCalls()).bodyRevisionReads - before).toBe(1);
  expect((await addin.wordCalls()).rejectedChanges).toEqual([]);
});

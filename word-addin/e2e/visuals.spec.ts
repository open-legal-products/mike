/**
 * Visuals in the Word pane: a `doc_created` frame for an HTML document opens
 * the visual in a sandboxed sheet as the turn streams, a chip in the steps
 * reopens it, a citation inside the visual selects the quoted passage in
 * Word, and "Insert into document" inserts the visual's Word file at the
 * selection.
 */
import { test, expect } from "./support/fixtures";

const TOKEN = "visuals-token";
const DOCUMENT_ID = "4b2d6f0e-6f4a-4c3b-9b0e-1f2a3b4c5d6e";
const VERSION_ID = "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const SOURCE_ID = "4f1b7e8a-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const QUOTE = "Term: 10 years";
const DOCUMENT_TEXT = `LEASE SUMMARY. ${QUOTE}. Rent is payable monthly.`;

const VISUAL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Lease map</title></head><body>
<p>Lease map marker</p>
<button data-cite="active" data-quote="${QUOTE}">1</button>
<button data-cite="${SOURCE_ID}" data-page="2">2</button>
<script>
document.querySelectorAll("button").forEach(function (button) {
  button.addEventListener("click", function () {
    parent.postMessage({ type: "mike:cite", cite: button.dataset.cite, quote: button.dataset.quote, page: button.dataset.page }, "*");
  });
});
parent.postMessage({ type: "mike:ready" }, "*");
</script>
</body></html>`;

const DOCX_BYTES = Buffer.from("PK docx bytes");

test.beforeEach(async ({ addin, page }) => {
  addin.seedToken(TOKEN);
  await page.route(`**/single-documents/${DOCUMENT_ID}/file?*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "content-disposition": 'attachment; filename="Lease map.html"' },
      body: VISUAL_HTML,
    }),
  );
  await page.route(`**/visuals/${DOCUMENT_ID}/docx?*`, (route) =>
    route.fulfill({
      status: 200,
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: DOCX_BYTES,
    }),
  );
  await addin.mockApiJson("GET", `**/visuals/${DOCUMENT_ID}/snapshot?*`, {
    created_at: "2026-10-20T14:32:00Z",
    sources: [{ document_id: SOURCE_ID, filename: "Lease schedule.xlsx", stale: true }],
  });
  await addin.mockChatStream(["Here is the lease map."], {
    chatId: "chat-visuals",
    assistantMessageId: "assistant-visuals",
    docCreated: [
      {
        filename: "Lease map.html",
        documentId: DOCUMENT_ID,
        versionId: VERSION_ID,
        versionNumber: 1,
      },
    ],
  });
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Map the lease.");
  await page.getByRole("button", { name: "Send" }).click();
});

test("the visual opens as the turn streams, a cite selects the passage in Word and the chip reopens it", async ({
  addin,
  page,
}) => {
  const sheet = page.getByRole("dialog", { name: "Lease map" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Lease map" })).toBeVisible();
  await expect(sheet.getByText("V1", { exact: true })).toBeVisible();
  await expect(sheet.getByText("A source has changed since this was made. Ask Mike to update it.")).toBeVisible();
  const frame = sheet.locator("iframe[data-mike-visual-frame]");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");

  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText("Here is the lease map.")).toBeVisible();
  await page.getByRole("button", { name: "Completed in 1 step" }).click();
  const chip = page.getByRole("button", { name: "Lease map" });
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(sheet).toBeVisible();

  const visual = page
    .frameLocator("iframe[data-mike-visual-frame]")
    .frameLocator("#visual");
  await expect(visual.getByText("Lease map marker")).toBeVisible();
  const searchesBefore = (await addin.wordCalls()).searches;
  await visual.getByRole("button", { name: "1" }).click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([{ text: QUOTE, location: "Select", original: QUOTE }]);
  expect((await addin.wordCalls()).searches).toBeGreaterThan(searchesBefore);

  // The host accepts one cite every 400 ms.
  await page.waitForTimeout(500);
  await visual.getByRole("button", { name: "2" }).click();
  await expect(page.getByText("From Lease schedule.xlsx, page 2.")).toBeVisible();

  await sheet.getByRole("button", { name: "Back to chat" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(chip).toBeFocused();
});

test("Insert into document inserts the visual's Word file in its own paragraph after the selection", async ({
  addin,
  page,
}) => {
  const sheet = page.getByRole("dialog", { name: "Lease map" });
  await sheet.getByRole("button", { name: "Insert into document" }).click();

  await expect
    .poll(async () => (await addin.wordCalls()).insertedFiles)
    .toEqual([{ base64: DOCX_BYTES.toString("base64"), location: "Replace" }]);
  await expect(page.getByRole("alert")).toHaveCount(0);

  await sheet.getByRole("button", { name: "Back to chat" }).click();
  await expect(sheet).toHaveCount(0);
});

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

test("large live prose shows its tail immediately and finishes with canonical Markdown", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { __APPEND_PROSE__?: () => void; __FINISH_PROSE__?: () => void };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "POST" || !new URL(url, window.location.href).pathname.endsWith("/word-chat")) return originalFetch(input, init);
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        const emit = (text: string) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "content_delta", text })}\n\n`));
        emit("Synthetic contract text. ".repeat(400));
        testWindow.__APPEND_PROSE__ = () => emit("\n\n**Checkpoint complete**\n\n[Reference][id]\n\n[id]: https://example.test\n\n<script>window.__PRIVATE_EXECUTED__=true</script>");
        testWindow.__FINISH_PROSE__ = () => { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); };
      } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof window.fetch;
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Explain the contract");
  await page.getByRole("button", { name: "Send" }).click();
  const assistant = page.locator("[data-assistant-message-id]").last();
  await expect(assistant).toContainText("Synthetic contract text.");
  await page.evaluate(() => (window as typeof window & { __APPEND_PROSE__?: () => void }).__APPEND_PROSE__?.());
  await expect(assistant).toContainText("**Checkpoint complete**");
  await expect(assistant.locator("strong")).toHaveCount(0);
  await page.evaluate(() => (window as typeof window & { __FINISH_PROSE__?: () => void }).__FINISH_PROSE__?.());
  await expect(assistant.locator("strong")).toHaveText("Checkpoint complete");
  await expect(assistant.getByRole("link", { name: "Reference" })).toHaveAttribute("href", "https://example.test");
  await expect(assistant.locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __PRIVATE_EXECUTED__?: boolean }).__PRIVATE_EXECUTED__)).toBeUndefined();
  expect((await assistant.textContent())?.match(/Checkpoint complete/g)).toHaveLength(1);
});

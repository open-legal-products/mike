import { expect, test } from "./support/fixtures";

test.use({ actionTimeout: 30_000 });

test("sixteen exchanges keep reasoning, resizing and disclosure updates bounded", async ({ addin, page, browserName }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  await page.setViewportSize({ width: 420, height: 720 });
  addin.seedToken("synthetic-streaming-session");
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let turn = 0;
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : null;
      const path = new URL(request?.url ?? String(input), location.href).pathname;
      const method = init?.method ?? request?.method ?? "GET";
      if (path !== "/api/word-chat" || method !== "POST") return originalFetch(input, init);
      const answer = ++turn;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          send({ type: "chat_id", chatId: "synthetic-streaming", assistantMessageId: `answer-${answer}` });
          if (answer <= 8) {
            send({ type: "content_delta", text: Array.from({ length: 30 }, (_, i) =>
              `Earlier clause ${answer}/${i}. **Review** these synthetic terms.\n\n`,
            ).join("") });
          } else {
            const chunks = answer <= 10 ? 150 : 24;
            for (let i = 0; i < chunks; i++) {
              send({ type: "reasoning_delta", text: `Reason ${answer}/${i}. **Review** the terms.\n\n` });
              await delay(1);
            }
            // Hold one live reasoning block for disclosure/resize checks.
            if (answer === 10) await new Promise<void>((resolve) => {
              (window as Window & { finishReasoning?: () => void }).finishReasoning = resolve;
            });
            send({ type: "reasoning_block_end" });
          }
          send({ type: "content_delta", text: `Final answer ${answer}.` });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  await addin.gotoTaskpane({ documentText: "Synthetic contract for streaming regression." });
  await addin.expectAuthedShell();

  for (let turn = 1; turn <= 16; turn++) {
    await test.step(`Exchange ${turn}`, async () => {
      await page.getByPlaceholder("How can I help?").fill(`Synthetic follow-up ${turn}`);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      if (turn === 10) {
        await page.waitForFunction(() => Boolean((window as Window & { finishReasoning?: () => void }).finishReasoning), undefined, { timeout: 180_000 });
        const assistant = page.locator("[data-assistant-message-id]").last();
        await assistant.getByRole("button", { name: "Expand thought process", exact: true }).click();
        await page.setViewportSize({ width: 320, height: 640 });
        // The fetch reader can finish before Word's batched publication paints
        // the final chunk. Wait for that content, then use the pane's explicit
        // bottom control; a single wheel tick does not wait for scrolling, and
        // automatic scrollIntoView fights the pane's owned scroll position.
        await expect(assistant.getByText("Reason 10/149.", { exact: false })).toBeVisible();
        await page.getByRole("button", { name: "Scroll to bottom", exact: true }).click();
        await expect.poll(() => page.getByTestId("messages-container").evaluate((element) =>
          Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight),
        )).toBeLessThan(2);
        await assistant.getByRole("button", { name: "Minimise thought process", exact: true }).click();
        const disclosure = assistant.getByRole("button", { name: /^(Thinking|Pondering|Analyzing|Reviewing|Reasoning)\.\.\.$/ });
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        await page.setViewportSize({ width: 420, height: 720 });
        await page.evaluate(() => (window as Window & { finishReasoning?: () => void }).finishReasoning?.());
      }
      await expect(page.getByText(`Final answer ${turn}.`, { exact: false })).toBeVisible({ timeout: 180_000 });
      await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
      expect(errors, `Browser errors after exchange ${turn}`).toEqual([]);
    });
  }
});

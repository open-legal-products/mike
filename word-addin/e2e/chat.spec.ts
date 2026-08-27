/**
 * E2E coverage for the composed ChatPanel/ChatView flow, the Word chat and
 * tracked-edit hooks, and api/stream.ts streamAssistant.
 *
 * Every test starts signed in (seeded token) so the authenticated Assistant
 * renders. The `/word-chat` SSE stream is mocked per test via the shared
 * `addin.mockChatStream` helper; no live backend is ever contacted.
 */
import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";
import { replacementEdit, wordEdits } from "./support/editProtocol";

const TOKEN = "test-jwt-token";

/**
 * Document reads and the tracked-change lifecycle are steps of the activity
 * strip, which collapses as soon as the answer streams in. Open it to read the
 * event rows.
 */
async function openActivityStrip(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /^(Working|Completed in \d+ steps?)/ })
    .first()
    .click();
}

async function chooseEditMode(page: Page): Promise<void> {
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
}

async function waitForStableSample<T>(read: () => Promise<T>): Promise<T> {
  let previous = "";
  let latest!: T;
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        latest = await read();
        const current = JSON.stringify(latest);
        stableSamples = current === previous ? stableSamples + 1 : 0;
        previous = current;
        return stableSamples;
      },
      { intervals: [50] },
    )
    .toBeGreaterThanOrEqual(2);
  return latest;
}

test.beforeEach(async ({ addin }) => {
  // Authenticated session => app shell + Assistant page instead of LoginPage.
  addin.seedToken(TOKEN);
});

test("shows frontend-style quick actions before any message is sent", async ({
  addin,
  page,
}) => {
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await expect(
    page.getByRole("heading", { name: "Hi, Test User" }),
  ).toBeVisible();
  await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Proofread agreement" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Compare documents" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Extract key terms" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Draft from template" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Extract key terms" }).click();
  await expect(
    page.getByRole("button", { name: "Remove workflow Extract Key Terms" }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("How can I help?")).toHaveValue(
    "Extract the key legal, commercial, and operational terms from the current document. Present them in a concise table with the term, value, location, and notes, and flag material omissions or ambiguities without inventing missing information.",
  );
  // No bubbles yet: the message list isn't rendered.
});

test("uses a floating icon header with no logo, tabs, or visible sign-out button", async ({
  addin,
  page,
}) => {
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("Mike", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);

  const header = page.getByTestId("floating-header");
  await expect(header.getByRole("button", { name: "New chat" })).toHaveCount(0);
  const chatInput = page.getByTestId("chat-input");
  const [headerBox, inputBox, headerPadding] = await Promise.all([
    header.boundingBox(),
    chatInput.boundingBox(),
    header.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft),
    ),
  ]);
  expect(headerBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  expect(Math.abs(inputBox!.x - headerBox!.x - headerPadding)).toBeLessThan(
    0.5,
  );
  expect(
    Math.abs(
      headerBox!.x +
        headerBox!.width -
        (inputBox!.x + inputBox!.width) -
        headerPadding,
    ),
  ).toBeLessThan(0.5);

  await page.getByRole("button", { name: "Open menu" }).click();
  // Radix takes the trigger out of the accessibility tree while its menu is
  // modal, but the button remains visibly rendered as the close control.
  await expect(page.locator('button[aria-label="Close menu"]')).toBeVisible();
  const assistantItem = page.getByRole("menuitem", { name: "Assistant" });
  const quickActionsItem = page.getByRole("menuitem", {
    name: "Quick Actions",
  });
  await expect(assistantItem).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Chat", exact: true }),
  ).toHaveCount(0);
  await expect(assistantItem).toHaveAttribute("data-selected", "true");
  await expect(page.getByRole("menu")).toHaveClass(/rounded-xl/);
  await expect(assistantItem).toHaveClass(/rounded-lg/);
  await expect(assistantItem.locator("svg")).toHaveCount(0);
  await quickActionsItem.hover();
  await expect(quickActionsItem).toHaveCSS("cursor", "pointer");
  await expect(quickActionsItem).not.toHaveAttribute("data-selected");
  await expect(quickActionsItem).not.toHaveAttribute("data-highlighted", "");
  await expect(quickActionsItem).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Projects" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  await expect(page.getByTestId("floating-header")).toHaveCSS(
    "position",
    "absolute",
  );
  await expect(page.getByTestId("chat-composer-overlay")).toHaveCSS(
    "position",
    "absolute",
  );
});

test("new chat clears the current conversation", async ({ addin, page }) => {
  await addin.mockChatStream(["Existing answer."]);
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Existing question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Existing answer.")).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByText("Existing question")).toHaveCount(0);
  await expect(page.getByText("Existing answer.")).toHaveCount(0);
  await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
});

test("section navigation preserves the live conversation and request history", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["First answer."], {
    chatId: "41eb8f61-d7af-454e-b680-cd28bd65c742",
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  const composer = page.getByPlaceholder("How can I help?");
  await composer.fill("First question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("First answer.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Quick Actions" }).click();
  await expect(
    page.getByText("Quick Actions", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();

  await expect(page.getByText("First question", { exact: true })).toBeVisible();
  await expect(page.getByText("First answer.", { exact: true })).toBeVisible();

  await composer.fill("Second question");
  const secondRequest = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const payload = (await secondRequest).postDataJSON();
  expect(payload.chat_id).toBe("41eb8f61-d7af-454e-b680-cd28bd65c742");
  expect(
    payload.messages.map((message: { content: string }) => message.content),
  ).toEqual(["First question", "First answer.", "Second question"]);
});

test("a document read from an old chat cannot resume into a new session", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["This stale response must never render."]);
  await addin.gotoTaskpane({
    documentText: "A deliberately delayed document.",
  });
  await addin.expectAuthedShell();

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      Word: {
        run: (...args: unknown[]) => Promise<unknown>;
      };
      __WORD_READ_WAITING__?: boolean;
      __RELEASE_WORD_READ__?: () => void;
    };
    const originalRun = testWindow.Word.run.bind(testWindow.Word);
    testWindow.Word.run = (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        testWindow.__WORD_READ_WAITING__ = true;
        testWindow.__RELEASE_WORD_READ__ = () => {
          testWindow.__RELEASE_WORD_READ__ = undefined;
          originalRun(...args).then(resolve, reject);
        };
      });
  });

  await page.getByPlaceholder("How can I help?").fill("Stale question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).__WORD_READ_WAITING__))
    .toBe(true);

  await page.getByRole("button", { name: "New chat" }).click();
  await page.evaluate(() => (window as any).__RELEASE_WORD_READ__?.());

  await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
  await expect(page.getByText("Stale question", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("This stale response must never render.", { exact: true }),
  ).toHaveCount(0);
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
});

test("does not send without the required Word document context", async ({
  addin,
  page,
}) => {
  await addin.gotoTaskpane({ documentText: "A contract body." });
  await addin.expectAuthedShell();

  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      Word: { run: () => Promise<never> };
    };
    testWindow.Word.run = () =>
      Promise.reject(new Error("Simulated document read failure"));
  });

  const composer = page.getByPlaceholder("How can I help?");
  await composer.fill("Review this document");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "Mike couldn't read the current Word document. Please try again.",
  );
  await expect(composer).toHaveValue("Review this document");
  await expect(page.locator("[data-message-id]")).toHaveCount(0);
});

test("history button loads and opens a previous chat", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("GET", "**/word-chat?*", [
    {
      id: "chat-1",
      project_id: null,
      user_id: "user-1",
      title: "Lease review",
      created_at: "2026-08-07T00:00:00Z",
    },
  ]);
  await addin.mockApiJson("GET", "**/word-chat/chat-1?*", {
    chat: {
      id: "chat-1",
      project_id: null,
      user_id: "user-1",
      title: "Lease review",
      created_at: "2026-08-07T00:00:00Z",
    },
    messages: [
      { id: "message-1", role: "user", content: "Review this lease" },
      {
        id: "message-2",
        role: "assistant",
        content: [
          { type: "doc_read", filename: "Demo Contract.docx" },
          { type: "content", text: "The lease has three risks." },
        ],
      },
    ],
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  const historyButton = page.getByRole("button", { name: "Chat history" });
  await expect(historyButton.locator("img")).toHaveCount(0);
  await expect(historyButton.locator("svg")).toHaveCount(1);
  await historyButton.click();
  const dropdown = page.getByRole("menu");
  await expect(
    dropdown.getByPlaceholder("Search recent chats..."),
  ).toBeVisible();
  await dropdown.getByRole("button", { name: /Lease review/ }).click();

  await expect(page.getByText("Review this lease")).toBeVisible();
  await expect(page.getByText("The lease has three risks.")).toBeVisible();
  await page.getByRole("button", { name: "Completed in 1 step" }).click();
  await expect(page.getByText("Read", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo Contract.docx")).toBeVisible();
});

test("shows a scroll-to-bottom control while the transcript is scrolled up", async ({
  addin,
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await addin.mockChatStream(["Review complete."], {
    assistantMessageId: "new-assistant-message",
  });
  await addin.mockApiJson("GET", "**/word-chat?*", [
    {
      id: "long-chat",
      project_id: null,
      user_id: "user-1",
      title: "Long document review",
      created_at: "2026-08-07T00:00:00Z",
    },
  ]);
  await addin.mockApiJson("GET", "**/word-chat/long-chat?*", {
    chat: {
      id: "long-chat",
      project_id: null,
      user_id: "user-1",
      title: "Long document review",
      created_at: "2026-08-07T00:00:00Z",
    },
    messages: Array.from({ length: 6 }, (_, index) => [
      {
        id: `long-user-${index}`,
        role: "user",
        content: `Review section ${index + 1}`,
      },
      {
        id: `long-assistant-${index}`,
        role: "assistant",
        content: `Section ${index + 1} contains several provisions that require careful review and follow-up.`,
      },
    ]).flat(),
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: /Long document review/ })
    .click();

  const scrollButton = page.getByRole("button", { name: "Scroll to bottom" });
  await expect(scrollButton).toBeVisible();
  await scrollButton.dispatchEvent("click");

  const immediateBottomDistance = await page
    .getByTestId("messages-container")
    .evaluate((container) =>
      Math.abs(
        container.scrollHeight - container.scrollTop - container.clientHeight,
      ),
    );
  expect(immediateBottomDistance).toBeLessThan(2);
  await expect(scrollButton).toHaveCount(0);

  await page
    .getByPlaceholder("How can I help?")
    .fill("Review the final section");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByText("Review the final section", { exact: true }),
  ).toBeVisible();

  const latestUserMessage = page.locator("[data-message-id]").last();
  await expect
    .poll(async () => {
      const messageBox = await latestUserMessage.boundingBox();
      return messageBox?.y ?? Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(100);
  await expect(
    page.getByText("Review complete.", { exact: true }),
  ).toBeVisible();
  const messagesContainer = page.getByTestId("messages-container");
  const settledMessageY = await waitForStableSample(async () =>
    latestUserMessage.evaluate((element) =>
      Math.round(element.getBoundingClientRect().y),
    ),
  );
  const [containerBox, firstMessageTop] = await Promise.all([
    messagesContainer.boundingBox(),
    page
      .locator("[data-message-id]")
      .first()
      .evaluate((element) => (element as HTMLElement).offsetTop),
  ]);
  expect(containerBox).not.toBeNull();
  expect(
    Math.abs(settledMessageY - (containerBox!.y + firstMessageTop)),
  ).toBeLessThan(2);
  const stableMessageY = (await latestUserMessage.boundingBox())?.y;
  expect(stableMessageY).toBeDefined();
  expect(Math.abs(stableMessageY! - settledMessageY)).toBeLessThan(2);
});

test("history preserves assistant event order and stored errors", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("GET", "**/word-chat?*", [
    {
      id: "ordered-chat",
      project_id: null,
      user_id: "user-1",
      title: "Ordered response",
      created_at: "2026-08-07T00:00:00Z",
    },
  ]);
  await addin.mockApiJson("GET", "**/word-chat/ordered-chat?*", {
    chat: {
      id: "ordered-chat",
      project_id: null,
      user_id: "user-1",
      title: "Ordered response",
      created_at: "2026-08-07T00:00:00Z",
    },
    messages: [
      { id: "ordered-user", role: "user", content: "Inspect this" },
      {
        id: "ordered-assistant",
        role: "assistant",
        content: [
          { type: "content", text: "I’ll inspect the document." },
          {
            type: "reasoning",
            text: "I should inspect the active document.",
            provider_metadata: { trace_id: "trace-1" },
          },
          {
            type: "doc_read",
            filename: "Demo Contract.docx",
            document_id: "active-document",
          },
          { type: "content", text: "The document has three risks." },
          { type: "error", message: "A stored follow-up failed." },
        ],
      },
    ],
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: /Ordered response/ })
    .click();

  const intro = page.getByText("I’ll inspect the document.", { exact: true });
  const activity = page.getByRole("button", { name: "Completed in 2 steps" });
  const summary = page.getByText("The document has three risks.", {
    exact: true,
  });
  const error = page.getByRole("alert");
  await expect(error).toHaveText("A stored follow-up failed.");
  await expect(
    page.getByText("I should inspect the active document."),
  ).toHaveCount(0);
  const [introBox, activityBox, summaryBox, errorBox] = await Promise.all([
    intro.boundingBox(),
    activity.boundingBox(),
    summary.boundingBox(),
    error.boundingBox(),
  ]);
  expect(introBox).not.toBeNull();
  expect(activityBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(errorBox).not.toBeNull();
  expect(introBox!.y).toBeLessThan(activityBox!.y);
  expect(activityBox!.y).toBeLessThan(summaryBox!.y);
  expect(summaryBox!.y).toBeLessThan(errorBox!.y);

  await activity.click();
  await page.getByRole("button", { name: "Thought process" }).click();
  await expect(
    page.getByText("I should inspect the active document."),
  ).toBeVisible();
});

test("typing + Send streams an assistant bubble that concatenates content_delta chunks", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["The contract ", "is ", "valid."]);
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page
    .getByPlaceholder("How can I help?")
    .fill("Summarize this document");
  await page.getByRole("button", { name: "Send" }).click();

  // The user's message renders as its own bubble...
  await expect(page.getByText("Summarize this document")).toBeVisible();
  // ...and the assistant bubble concatenates every chunk, stopping at [DONE].
  await expect(page.getByText("The contract is valid.")).toBeVisible();
  // Content-only streams must not invent reasoning activity.
  const assistant = page.locator("[data-assistant-message-id]").last();
  await expect(assistant.getByText("Thinking...", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    assistant.getByRole("button", {
      name: /^(Working|Completed in \d+ steps?)/,
    }),
  ).toHaveCount(0);
  // Initial quick actions are gone once messages exist.
  await expect(page.getByText("Quick actions", { exact: true })).toHaveCount(0);
});

test("a reasoning delta replaces Thinking with a live reasoning trace", async ({
  addin,
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      __FINISH_REASONING__?: () => void;
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const requestMethod =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        requestMethod.toUpperCase() !== "POST" ||
        !new URL(requestUrl, window.location.href).pathname.endsWith(
          "/word-chat",
        )
      ) {
        return originalFetch(input, init);
      }

      const encoder = new TextEncoder();
      const frame = (value: unknown): Uint8Array =>
        encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            frame({ type: "reasoning_delta", text: "I should inspect the " }),
          );
          controller.enqueue(
            frame({ type: "reasoning_delta", text: "agreement first." }),
          );
          testWindow.__FINISH_REASONING__ = () => {
            controller.enqueue(frame({ type: "reasoning_block_end" }));
            controller.enqueue(
              frame({
                type: "content_delta",
                text: "The agreement is valid.",
              }),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof window.fetch;
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Review the agreement");
  await page.getByRole("button", { name: "Send" }).click();

  const assistant = page.locator("[data-assistant-message-id]").last();
  await expect(
    assistant.getByText("Thinking...", { exact: true }),
  ).toBeVisible();
  await expect(
    assistant.getByText("I should inspect the agreement first.", {
      exact: true,
    }),
  ).toBeVisible();
  const liveReasoningToggle = assistant.getByRole("button", {
    name: "Thinking...",
  });
  await expect(liveReasoningToggle).toHaveAttribute("aria-expanded", "true");
  await liveReasoningToggle.click();
  await expect(
    assistant.getByText("I should inspect the agreement first.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(liveReasoningToggle).toHaveAttribute("aria-expanded", "false");
  await liveReasoningToggle.click();
  await expect(
    assistant.getByText("I should inspect the agreement first.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.evaluate(() => {
    (
      window as typeof window & { __FINISH_REASONING__?: () => void }
    ).__FINISH_REASONING__?.();
  });
  await expect(assistant.getByText("The agreement is valid.")).toBeVisible();

  await assistant.getByRole("button", { name: "Completed in 1 step" }).click();
  await assistant.getByRole("button", { name: "Thought process" }).click();
  await expect(
    assistant.getByText("I should inspect the agreement first.", {
      exact: true,
    }),
  ).toBeVisible();
});

test("a pre-[DONE] error event surfaces as 'Error: ...' in the assistant bubble", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["partial answer"], {
    errorBefore: "model rate limited",
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Do something");
  await page.getByRole("button", { name: "Send" }).click();

  // The client throws on the pre-[DONE] error; ChatPanel replaces the bubble
  // content with the error message.
  await expect(page.getByText("Error: model rate limited")).toBeVisible();
});

test("sends a document snapshot without claiming the model read it", async ({
  addin,
  page,
}) => {
  const docText = "This Agreement is governed by the laws of Delaware.";
  await addin.mockChatStream(["ok"]);
  await addin.gotoTaskpane({ documentText: docText });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("What law governs?");

  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const request = await requestPromise;

  const body = request.postDataJSON();
  expect(body.document_context).toBe(docText);
  expect(body.document_name).toBe("Demo Contract.docx");
  expect(body.storage).toBe("cloud");
  expect(body.document_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  await expect(page.getByText("Read", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Completed in \d+ steps?/ }),
  ).toHaveCount(0);
});

test("uses Web Crypto for document IDs when randomUUID is unavailable", async ({
  addin,
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
  await addin.mockChatStream(["ok"]);
  await addin.gotoTaskpane({ documentText: "Fallback UUID test" });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Check this document");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();

  expect(body.document_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect((await addin.wordDocument()).settings["mike.word.documentId.v1"]).toBe(
    body.document_id,
  );
});

test("a Save As copy of the document mints a fresh chat identity", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["ok"]);
  await addin.gotoTaskpane({ documentText: "Copy detection test" });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("First question");
  const firstRequest = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const firstId = (await firstRequest).postDataJSON().document_id as string;

  // Simulate "Save As": document settings travel inside the .docx (the mock
  // persists them in sessionStorage), but the copy opens from a new URL. Seed
  // a stale anchor registry to prove the copy does not inherit it either.
  await addin.setWordDocumentSetting("mike.wordEditAnchors.v1", {
    version: 1,
    anchors: {},
  });
  await addin.gotoTaskpane({
    documentUrl: "C:/Users/e2e/Demo Contract (Copy).docx",
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Second question");
  const secondRequest = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const secondId = (await secondRequest).postDataJSON().document_id as string;

  expect(secondId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(secondId).not.toBe(firstId);
  const { settings } = await addin.wordDocument();
  expect(settings["mike.word.documentId.v1"]).toBe(secondId);
  expect(settings["mike.word.documentUrl.v1"]).toBe(
    "c:/users/e2e/demo contract (copy).docx",
  );
  expect(settings["mike.wordEditAnchors.v1"]).toBeUndefined();
});

test("keeps the existing identity when either document URL is unknown", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["ok"]);
  await addin.gotoTaskpane({ documentText: "Conservative identity test" });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("First question");
  const firstRequest = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const firstId = (await firstRequest).postDataJSON().document_id as string;

  // Pre-URL-tracking upgrade path: an identity exists but no URL was stored.
  // Even at a brand-new URL this must NOT count as a copy.
  await addin.removeWordDocumentSetting("mike.word.documentUrl.v1");
  await addin.gotoTaskpane({
    documentUrl: "C:/Users/e2e/Renamed Contract.docx",
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Second question");
  const secondRequest = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  expect((await secondRequest).postDataJSON().document_id).toBe(firstId);

  // Unsaved-document path: the current URL is empty, so the stored identity
  // (and the URL adopted above) must survive untouched.
  await addin.gotoTaskpane({ documentUrl: "" });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Third question");
  const thirdRequest = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  expect((await thirdRequest).postDataJSON().document_id).toBe(firstId);
  expect(
    (await addin.wordDocument()).settings["mike.word.documentUrl.v1"],
  ).toBe("c:/users/e2e/renamed contract.docx");
});

test("shows Reading and Read only when the model triggers the read tool", async ({
  addin,
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      __FINISH_DOCUMENT_READ__?: () => void;
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        !new URL(requestUrl, window.location.href).pathname.endsWith(
          "/word-chat",
        )
      ) {
        return originalFetch(input, init);
      }
      const encoder = new TextEncoder();
      const frame = (value: unknown): Uint8Array =>
        encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            frame({
              type: "doc_read_start",
              filename: "Demo Contract.docx",
            }),
          );
          testWindow.__FINISH_DOCUMENT_READ__ = () => {
            controller.enqueue(
              frame({ type: "doc_read", filename: "Demo Contract.docx" }),
            );
            controller.enqueue(
              frame({
                type: "content_delta",
                text: "The agreement uses Delaware law.",
              }),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof window.fetch;
  });
  await addin.gotoTaskpane({ documentText: "Delaware governs." });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("What law governs?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Reading", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo Contract.docx...")).toBeVisible();
  await page.evaluate(() => {
    (
      window as typeof window & { __FINISH_DOCUMENT_READ__?: () => void }
    ).__FINISH_DOCUMENT_READ__?.();
  });
  await expect(
    page.getByText("The agreement uses Delaware law."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Completed in 1 step" }).click();
  await expect(page.getByText("Read", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo Contract.docx")).toBeVisible();
});

test("removes an unfinished Reading event when the stream is stopped", async ({
  addin,
  page,
}) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        !new URL(requestUrl, window.location.href).pathname.endsWith(
          "/word-chat",
        )
      ) {
        return originalFetch(input, init);
      }
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "doc_read_start",
                filename: "Demo Contract.docx",
              })}\n\n`,
            ),
          );
          init?.signal?.addEventListener(
            "abort",
            () =>
              controller.error(
                new DOMException("The request was aborted.", "AbortError"),
              ),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof window.fetch;
  });
  await addin.gotoTaskpane({ documentText: "Delaware governs." });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Review the document");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Reading", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(page.getByText("Reading", { exact: true })).toHaveCount(0);
});

test("document context and tracked-edit behavior are fixed on without switches", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["ok"]);
  const docText = "Some document body text.";
  await addin.gotoTaskpane({ documentText: docText });
  await addin.expectAuthedShell();

  // Document context and change tracking have no opt-out controls. The
  // apply-mode control is a menu button (Review/Direct), which governs how
  // edits are resolved — never whether the document is sent or tracked — so
  // the pane exposes no switches at all.
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByTestId("edit-apply-toggle")).toHaveText(/Review/);

  await page.getByPlaceholder("How can I help?").fill("Hello");

  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const request = await requestPromise;

  const body = request.postDataJSON();
  expect(body.document_context).toBe(docText);
  const lastMessage = body.messages[body.messages.length - 1];
  expect(lastMessage.content).toBe("Hello");
});

test("Enter sends the message", async ({ addin, page }) => {
  await addin.mockChatStream(["Replied via Enter."]);
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  const input = page.getByPlaceholder("How can I help?");
  await input.fill("Send with Enter");
  await input.press("Enter");

  await expect(page.getByText("Send with Enter")).toBeVisible();
  await expect(page.getByText("Replied via Enter.")).toBeVisible();
});

test("Shift+Enter does not send the message", async ({ addin, page }) => {
  await addin.mockChatStream(["should not appear"]);
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  const input = page.getByPlaceholder("How can I help?");
  await input.fill("Draft line one");
  await input.press("Shift+Enter");

  // No request fired => initial actions remain and input retains its text. The composer
  // is a multi-line textarea, so Shift+Enter inserts a newline rather than
  // sending — assert the typed text is preserved (a trailing newline is fine).
  await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
  await expect(input).toHaveValue(/^Draft line one/);
});

test("the composer swaps Send for a Stop control while streaming, then restores", async ({
  addin,
  page,
}) => {
  // Hold the stream behind an explicit gate so assertions do not depend on a
  // machine-specific delay.
  const stream = await addin.mockChatStream(["Slow streamed reply."], {
    deferred: true,
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  const input = page.getByPlaceholder("How can I help?");

  await input.fill("Take your time");
  await page.getByRole("button", { name: "Send" }).click();

  const responseStatus = page
    .locator("[data-assistant-message-id]")
    .last()
    .getByTestId("assistant-response-status");
  const mikeLoader = responseStatus.locator('svg[viewBox="100 100 300 300"]');

  // While streaming: the textarea remains available for composing the next
  // turn, while Send is replaced by a reachable Stop control.
  await expect(input).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  await expect(mikeLoader).toBeVisible();
  await expect(
    page
      .locator("[data-assistant-message-id]")
      .last()
      .getByText("Thinking...", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator("[data-assistant-message-id]")
      .last()
      .getByRole("button", { name: /^(Working|Completed in \d+ steps?)/ }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      mikeLoader.evaluate(
        (icon) => (icon.parentElement as HTMLElement).style.animationPlayState,
      ),
    )
    .toBe("running");

  stream.release();

  // Once the stream finishes Send returns.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect
    .poll(() =>
      mikeLoader.evaluate(
        (icon) => (icon.parentElement as HTMLElement).style.animationPlayState,
      ),
    )
    .toBe("paused");
});

// ---------------------------------------------------------------------------
// Server-side tracked-edit protocol
// ---------------------------------------------------------------------------
test("sends only user text because tracked-edit instructions are server-side", async ({
  addin,
  page,
}) => {
  const docText = "The Suplier shall deliver the goods.";
  await addin.mockChatStream(["ok"]);
  await addin.gotoTaskpane({ documentText: docText });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the typos");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const request = await requestPromise;

  const body = request.postDataJSON();
  expect(body.document_context).toBe(docText);
  const lastMessage = body.messages[body.messages.length - 1];
  expect(lastMessage.content).toBe("Fix the typos");

  // The transcript and request both contain only what the user typed.
  await expect(page.getByText("Fix the typos")).toBeVisible();
  await expect(page.getByText("character-for-character")).toHaveCount(0);
});

test("opens a left-aligned source menu and selects web files from the document modal", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("GET", "**/library/files?*", {
    documents: [],
    folders: [],
  });
  await addin.mockStandaloneDocumentUpload({
    id: "doc-uploaded",
    project_id: null,
    filename: "agreement.pdf",
    file_type: "pdf",
    storage_path: "documents/agreement.pdf",
    pdf_storage_path: null,
    size_bytes: 12,
    page_count: 1,
    structure_tree: null,
    status: "ready",
    created_at: "2026-08-07T00:00:00Z",
  });
  await addin.mockChatStream(["Document received."]);
  await addin.gotoTaskpane({ documentText: "Current Word document" });
  await addin.expectAuthedShell();

  const addDocumentsButton = page.getByRole("button", {
    name: "Add documents",
  });
  const buttonBox = await addDocumentsButton.boundingBox();
  await addDocumentsButton.click();
  const localFiles = page.getByRole("menuitem", { name: "Desktop Files" });
  const webFiles = page.getByRole("menuitem", { name: "Web files" });
  await expect(localFiles).toBeVisible();
  await expect(webFiles).toBeVisible();
  await expect(localFiles.locator('img[src*="desktop."]')).toBeVisible();
  await expect(webFiles.locator('img[src*="earth."]')).toBeVisible();

  const menuBox = await page.getByRole("menu").boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(Math.abs(menuBox!.x - buttonBox!.x)).toBeLessThanOrEqual(2);

  await webFiles.click();
  const modal = page.getByRole("dialog", { name: "Add Documents" });
  await expect(modal).toBeVisible();

  const chooserPromise = page.waitForEvent("filechooser");
  await modal.getByRole("button", { name: "Upload" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "agreement.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("test pdf"),
  });

  await expect(modal.getByText("agreement.pdf")).toBeVisible();
  await expect(modal.getByText("Date", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("Size", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("Name", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("12 B", { exact: true })).toHaveCount(0);
  const tabsScroll = modal.getByTestId("document-tabs-scroll");
  await expect(tabsScroll).toHaveCSS("padding-left", "8px");
  await expect(tabsScroll).toHaveCSS("padding-top", "8px");
  await expect(tabsScroll).toHaveCSS("overflow-x", "auto");
  const [tabsScrollBox, filesTabBox] = await Promise.all([
    tabsScroll.boundingBox(),
    modal.getByRole("button", { name: "Files", exact: true }).boundingBox(),
  ]);
  expect(tabsScrollBox).not.toBeNull();
  expect(filesTabBox).not.toBeNull();
  expect(filesTabBox!.x - tabsScrollBox!.x).toBeGreaterThanOrEqual(8);
  expect(filesTabBox!.y - tabsScrollBox!.y).toBeGreaterThanOrEqual(8);
  await expect(modal.locator('img[src*="/icons/pdf."]')).toBeVisible();
  const uploadedRow = modal.getByRole("button", { name: /agreement\.pdf/ });
  const documentsScroll = modal.locator(".overflow-y-auto").last();
  await expect(documentsScroll).toHaveCSS("padding-left", "8px");
  await expect(documentsScroll).toHaveCSS("margin-left", "-8px");
  const [documentSearchBox, uploadedRowBox] = await Promise.all([
    modal.getByPlaceholder("Search...").locator("..").boundingBox(),
    uploadedRow.boundingBox(),
  ]);
  expect(documentSearchBox).not.toBeNull();
  expect(uploadedRowBox).not.toBeNull();
  expect(
    Math.abs(uploadedRowBox!.x - documentSearchBox!.x),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(uploadedRowBox!.width - documentSearchBox!.width),
  ).toBeLessThanOrEqual(1);
  await expect(uploadedRow).toHaveAttribute("aria-pressed", "true");
  await uploadedRow.click();
  await expect(uploadedRow).toHaveAttribute("aria-pressed", "false");
  await uploadedRow.click();
  await expect(uploadedRow).toHaveAttribute("aria-pressed", "true");
  await modal.getByRole("button", { name: "Confirm" }).click();
  await expect(modal).toHaveCount(0);
  await expect(
    page.getByTestId("chat-input").getByText("agreement.pdf"),
  ).toBeVisible();
  await page.getByPlaceholder("How can I help?").fill("Review the attachment");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();
  const lastMessage = body.messages[body.messages.length - 1];
  expect(lastMessage.files).toEqual([
    { filename: "agreement.pdf", document_id: "doc-uploaded" },
  ]);
});

test("attaches a library template from the Templates tab", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("GET", "**/library/files?*", {
    documents: [],
    folders: [],
  });
  await addin.mockApiJson("GET", "**/library/templates?*", {
    documents: [
      {
        id: "template-1",
        filename: "NDA template.docx",
        file_type: "docx",
        size_bytes: 2048,
        created_at: "2026-08-08T00:00:00Z",
      },
    ],
    folders: [],
  });
  await addin.mockChatStream(["Template received."]);
  await addin.gotoTaskpane();

  await page.getByRole("button", { name: "Add documents" }).click();
  await page.getByRole("menuitem", { name: "Web files" }).click();
  const modal = page.getByRole("dialog", { name: "Add Documents" });
  await modal.getByRole("button", { name: "Templates" }).click();
  const template = modal.getByRole("button", { name: /NDA template\.docx/ });
  await expect(template).toBeVisible();
  await template.click();
  await expect(template).toHaveAttribute("aria-pressed", "true");
  await modal.getByRole("button", { name: "Confirm" }).click();

  await page
    .getByPlaceholder("How can I help?")
    .fill("Draft from this template");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const payload = (await requestPromise).postDataJSON();
  expect(payload.messages.at(-1).files).toEqual([
    { filename: "NDA template.docx", document_id: "template-1" },
  ]);
});

test("expands a project and attaches one of its documents", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("GET", "**/library/files?*", {
    documents: [],
    folders: [],
  });
  await addin.mockApiJson("GET", "**/projects?*", [
    {
      id: "project-1",
      name: "Matter Atlas",
      cm_number: "CM-42",
      created_at: "2026-08-08T00:00:00Z",
      document_count: 1,
    },
  ]);
  await addin.mockApiJson("GET", "**/projects/project-1/directory?*", {
    documents: [
      {
        id: "project-doc-1",
        filename: "Disclosure letter.pdf",
        file_type: "pdf",
        size_bytes: 1024,
        created_at: "2026-08-08T00:00:00Z",
      },
    ],
    folders: [],
    documentsHasMore: false,
  });
  await addin.mockChatStream(["Project document received."]);
  await addin.gotoTaskpane();

  await page.getByRole("button", { name: "Add documents" }).click();
  await page.getByRole("menuitem", { name: "Web files" }).click();
  const modal = page.getByRole("dialog", { name: "Add Documents" });
  await modal.getByRole("button", { name: "Projects" }).click();
  await modal.getByRole("button", { name: /Matter Atlas/ }).click();
  const projectDocument = modal.getByRole("button", {
    name: /Disclosure letter\.pdf/,
  });
  await expect(projectDocument).toBeVisible();
  await projectDocument.click();
  await modal.getByRole("button", { name: "Confirm" }).click();

  await page.getByPlaceholder("How can I help?").fill("Review the disclosure");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const payload = (await requestPromise).postDataJSON();
  expect(payload.messages.at(-1).files).toEqual([
    { filename: "Disclosure letter.pdf", document_id: "project-doc-1" },
  ]);
});

test("reports a Templates-tab load failure", async ({ addin, page }) => {
  await addin.mockApiJson("GET", "**/library/files?*", {
    documents: [],
    folders: [],
  });
  await addin.mockApiError(
    "GET",
    "**/library/templates?*",
    503,
    "Templates temporarily unavailable",
  );
  await addin.gotoTaskpane();

  await page.getByRole("button", { name: "Add documents" }).click();
  await page.getByRole("menuitem", { name: "Web files" }).click();
  const modal = page.getByRole("dialog", { name: "Add Documents" });
  await modal.getByRole("button", { name: "Templates" }).click();
  await expect(modal.getByRole("alert")).toContainText("API error: 503");
});

test("uploads desktop files directly from the document source menu", async ({
  addin,
  page,
}) => {
  await addin.mockStandaloneDocumentUpload({
    id: "doc-local",
    project_id: null,
    filename: "local-contract.docx",
    file_type: "docx",
    storage_path: "documents/local-contract.docx",
    pdf_storage_path: null,
    size_bytes: 14,
    page_count: 1,
    structure_tree: null,
    status: "ready",
    created_at: "2026-08-07T00:00:00Z",
  });
  await addin.mockChatStream(["Local document received."]);
  await addin.gotoTaskpane({ documentText: "Current Word document" });
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Add documents" }).click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Desktop Files" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "local-contract.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("test docx"),
  });

  await expect(page.getByText("local-contract.docx")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Add Documents" })).toHaveCount(
    0,
  );

  await page.getByPlaceholder("How can I help?").fill("Review the local file");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();
  const lastMessage = body.messages[body.messages.length - 1];
  expect(lastMessage.files).toEqual([
    { filename: "local-contract.docx", document_id: "doc-local" },
  ]);
});

test("selects a workflow from the plus menu and attaches it to chat", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("GET", "**/workflows**", [
    {
      id: "wf-review",
      user_id: "user-1",
      metadata: {
        title: "Contract review",
        description: "Review a contract",
        type: "assistant",
        contributors: [],
        language: "en",
        version: null,
        practice: "Commercial",
        jurisdictions: null,
      },
      skill_md: "Review the contract carefully.",
      columns_config: null,
      is_system: false,
      created_at: "2026-08-07T00:00:00Z",
    },
    {
      id: "wf-summary",
      user_id: null,
      metadata: {
        title: "Summarize document",
        description: null,
        type: "assistant",
        contributors: [],
        language: "en",
        version: null,
        practice: null,
        jurisdictions: null,
      },
      skill_md: "Summarize the document.",
      columns_config: null,
      is_system: true,
      created_at: "2026-08-07T00:00:00Z",
    },
  ]);
  await addin.mockChatStream(["Workflow complete."]);
  await addin.gotoTaskpane({ documentText: "Current Word document" });
  await addin.expectAuthedShell();

  // Workflows are reached through the "+" menu rather than a dedicated
  // composer button.
  await page.getByRole("button", { name: "Add documents" }).click();
  await page.getByRole("menuitem", { name: "Workflows" }).click();
  const modal = page.getByRole("dialog", { name: "Add workflow" });
  await expect(modal).toBeVisible();
  await expect(modal.getByText("Contract review")).toBeVisible();
  await expect(modal.getByText("Summarize document")).toBeVisible();
  const contractWorkflow = modal.getByRole("button", {
    name: /Contract review/,
  });
  const [workflowSearchBox, contractWorkflowBox] = await Promise.all([
    modal.getByPlaceholder("Search workflows...").locator("..").boundingBox(),
    contractWorkflow.boundingBox(),
  ]);
  expect(workflowSearchBox).not.toBeNull();
  expect(contractWorkflowBox).not.toBeNull();
  expect(
    Math.abs(contractWorkflowBox!.x - workflowSearchBox!.x),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(contractWorkflowBox!.width - workflowSearchBox!.width),
  ).toBeLessThanOrEqual(1);
  await expect(contractWorkflow.getByText("Commercial")).toBeVisible();
  await expect(contractWorkflow.locator("svg")).toHaveCount(0);
  await expect(modal.getByText("System", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("Custom", { exact: true })).toHaveCount(0);
  await expect(contractWorkflow).toHaveAttribute("aria-pressed", "false");
  await contractWorkflow.click();
  await expect(contractWorkflow).toHaveAttribute("aria-pressed", "true");
  await modal.getByRole("button", { name: "Use" }).click();

  await expect(
    page.getByTestId("chat-input").getByText("Contract review"),
  ).toBeVisible();

  await page.getByPlaceholder("How can I help?").fill("Run this workflow");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();
  const lastMessage = body.messages[body.messages.length - 1];
  expect(lastMessage.workflow).toEqual({
    id: "wf-review",
    title: "Contract review",
  });
});

test("model toggle sends the selected frontend model", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["Using the selected model."]);
  await addin.gotoTaskpane({ documentText: "Current Word document" });
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("menuitem", { name: "OpenAI", exact: true }).click();
  await page.getByRole("menuitem", { name: "GPT-5.4", exact: true }).click();
  await page.getByPlaceholder("How can I help?").fill("Hello");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();
  expect(body.model).toBe("gpt-5.4");
});

test("composer controls fit a narrow Word task pane", async ({
  addin,
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await addin.mockApiJson("GET", "**/library/files?*", {
    documents: [],
    folders: [],
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await expect(
    page.getByRole("button", { name: "Add documents" }),
  ).toBeVisible();
  await expect(page.getByTestId("edit-apply-toggle")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose model" }),
  ).toBeVisible();
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toHaveClass(/rounded-\[11px\]/);
  await expect(sendButton).toHaveClass(/border-0/);

  const placeholderBounds = await page
    .getByPlaceholder("How can I help?")
    .boundingBox();
  const plusBounds = await page
    .getByRole("button", { name: "Add documents" })
    .locator("svg")
    .boundingBox();
  const addDocumentBounds = await page
    .getByRole("button", { name: "Add documents" })
    .boundingBox();
  const applyModeBounds = await page
    .getByTestId("edit-apply-toggle")
    .boundingBox();
  const modelBounds = await page
    .getByRole("button", { name: "Choose model" })
    .boundingBox();
  expect(placeholderBounds).not.toBeNull();
  expect(plusBounds).not.toBeNull();
  expect(addDocumentBounds).not.toBeNull();
  expect(applyModeBounds).not.toBeNull();
  expect(modelBounds).not.toBeNull();
  expect(Math.abs(plusBounds!.x - placeholderBounds!.x)).toBeLessThanOrEqual(3);
  // The whole action row shares one line: mode pill after the documents
  // button, icon-only model button flush inside the pane.
  expect(
    Math.abs(applyModeBounds!.y - addDocumentBounds!.y),
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(modelBounds!.y - addDocumentBounds!.y)).toBeLessThanOrEqual(
    2,
  );
  expect(modelBounds!.x + modelBounds!.width).toBeLessThanOrEqual(360);

  await page.getByRole("button", { name: "Add documents" }).click();
  await page.getByRole("menuitem", { name: "Web files" }).click();
  const documentsModal = page.getByRole("dialog", { name: "Add Documents" });
  await expect(documentsModal).toBeVisible();
  const documentsBounds = await documentsModal.boundingBox();
  expect(documentsBounds).not.toBeNull();
  expect(documentsBounds!.x).toBeGreaterThanOrEqual(0);
  expect(documentsBounds!.x + documentsBounds!.width).toBeLessThanOrEqual(360);
  await documentsModal.getByRole("button", { name: "Close" }).click();

  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("composer grows upward when narrower text wraps onto more lines", async ({
  addin,
  page,
}) => {
  const resizeObserverErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (error.message.includes("ResizeObserver")) {
      resizeObserverErrors.push(error.message);
    }
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("ResizeObserver")
    ) {
      resizeObserverErrors.push(message.text());
    }
  });
  await page.setViewportSize({ width: 360, height: 760 });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page
    .getByPlaceholder("How can I help?")
    .fill(
      "Review the document and identify every important contractual obligation, exception, limitation, deadline, dependency, and material risk.",
    );
  const chatInput = page.getByTestId("chat-input");
  const wideBounds = await chatInput.boundingBox();
  expect(wideBounds).not.toBeNull();

  await page.setViewportSize({ width: 260, height: 760 });
  await expect
    .poll(async () => (await chatInput.boundingBox())?.height ?? 0)
    .toBeGreaterThan(wideBounds!.height);

  const narrowBounds = await chatInput.boundingBox();
  expect(narrowBounds).not.toBeNull();
  expect(narrowBounds!.y).toBeLessThan(wideBounds!.y);
  expect(
    Math.abs(
      narrowBounds!.y +
        narrowBounds!.height -
        (wideBounds!.y + wideBounds!.height),
    ),
  ).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 320, height: 760 });
  await page.setViewportSize({ width: 280, height: 760 });
  await page.setViewportSize({ width: 340, height: 760 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(resizeObserverErrors).toEqual([]);
});

test("streams sealed edit cards into Word and resolves their exact revisions", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(
    [
      "Two issues found.\n\n",
      wordEdits(
        replacementEdit("The Suplier", "The Supplier", "Typo."),
        replacementEdit(
          "shall deliver goods",
          "shall deliver the goods",
          "Missing article.",
        ),
      ),
    ],
    { docReads: ["Demo Contract.docx"] },
  );
  await addin.gotoTaskpane({
    documentText: "The Suplier shall deliver goods to the Buyer.",
  });
  await addin.expectAuthedShell();
  await chooseEditMode(page);

  await page.getByPlaceholder("How can I help?").fill("Propose edits");
  await page.getByRole("button", { name: "Send" }).click();

  // Edit mode applies sealed blocks without a separate Apply click.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(2);
  await expect(page.getByText("Two issues found.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("<EDITS>");
  await expect(page.getByText("The Supplier", { exact: true })).toBeVisible();
  await expect(
    page.getByText("shall deliver the goods", { exact: true }),
  ).toBeVisible();

  // Both per-card and grouped resolution controls are available once Word has
  // returned the exact generated TrackedChange proxies.
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Accept all" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject all" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toHaveCount(2);

  // Only pre-response work belongs in the activity strip; tracked edits are
  // represented by the edit cards below the streamed response.
  await expect(
    page.getByRole("button", { name: /Completed in 1 step/ }),
  ).toBeVisible();
  await openActivityStrip(page);
  await expect(page.getByText("Tracked change ready for review")).toHaveCount(
    0,
  );
  await expect(page.getByText("Read", { exact: true })).toBeVisible();

  let calls = await addin.wordCalls();
  expect(calls.trackedChanges).toEqual([
    { text: "The Supplier", location: "After", original: "The Suplier" },
    {
      text: "shall deliver the goods",
      location: "After",
      original: "shall deliver goods",
    },
  ]);
  expect(calls.changeTrackingMode).toBe("TrackAll");
  expect(calls.inserts).toEqual([]);

  await page
    .getByRole("button", { name: "Accept", exact: true })
    .first()
    .click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  const scrollToBottom = page.getByRole("button", {
    name: "Scroll to bottom",
  });
  await expect(scrollToBottom).toBeVisible();
  await scrollToBottom.click();
  const rejectButton = page
    .getByRole("button", { name: "Reject", exact: true })
    .first();
  await rejectButton.click();
  await expect(page.getByText("Rejected.", { exact: true })).toBeVisible();

  calls = await addin.wordCalls();
  expect(calls.acceptedChanges).toEqual([
    { text: "The Supplier", location: "After", original: "The Suplier" },
  ]);
  expect(calls.rejectedChanges).toEqual([
    {
      text: "shall deliver the goods",
      location: "After",
      original: "shall deliver goods",
    },
  ]);
});

test("hides a provisional edit card until it can be reviewed and applied", async ({
  addin,
  page,
}) => {
  await page.addInitScript(() => {
    const streamWindow = window as typeof window & {
      __CONTINUE_REDLINE_STREAM__?: () => void;
    };
    const originalFetch = window.fetch.bind(window);

    window.fetch = (async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        !new URL(requestUrl, window.location.href).pathname.endsWith(
          "/word-chat",
        )
      ) {
        return originalFetch(input, init);
      }

      const encoder = new TextEncoder();
      const event = (text: string): Uint8Array =>
        encoder.encode(
          `data: ${JSON.stringify({ type: "content_delta", text })}\n\n`,
        );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            event(
              '<EDITS>[{"type":"edit_data","kind":"edit",' +
                '"deleted_text":"The Suplier","inserted_text":"The Supp',
            ),
          );
          let continued = false;
          streamWindow.__CONTINUE_REDLINE_STREAM__ = () => {
            if (continued) return;
            continued = true;
            controller.enqueue(event('lier","reason":"Typo."}]</EDITS>\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };
        },
      });

      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }) as typeof window.fetch;
  });

  await addin.gotoTaskpane({
    documentText: "The Suplier delivered the goods.",
  });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Receiving change…")).toHaveCount(0);
  await expect(page.getByText("The Supp", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("<EDITS>");
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (
            window as typeof window & {
              __CONTINUE_REDLINE_STREAM__?: () => void;
            }
          ).__CONTINUE_REDLINE_STREAM__,
      ),
    )
    .toBe("function");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.evaluate(() => {
    (
      window as typeof window & {
        __CONTINUE_REDLINE_STREAM__?: () => void;
      }
    ).__CONTINUE_REDLINE_STREAM__?.();
  });

  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([
      { text: "The Supplier", location: "After", original: "The Suplier" },
    ]);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Tracked change ready for review")).toHaveCount(
    0,
  );
});

test("View scrolls Word to a proposed change before it is applied", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(replacementEdit("The Suplier", "The Supplier", "Typo.")),
  ]);
  await addin.gotoTaskpane({
    documentText: "The Suplier shall deliver the goods.",
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  const view = page.getByRole("button", { name: "View", exact: true });
  await expect(view).toBeVisible();
  expect((await addin.wordCalls()).revealedChanges).toEqual([]);

  await view.click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([
      { text: "The Suplier", location: "Select", original: "The Suplier" },
    ]);
  // Viewing is navigation only: the proposal remains unapplied.
  await expect(view).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();
  const calls = await addin.wordCalls();
  expect(calls.trackedChanges).toEqual([]);
  expect(calls.acceptedChanges).toEqual([]);
  expect(calls.rejectedChanges).toEqual([]);
});

test("View falls back to a second anchor when Word invalidates the first", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(replacementEdit("The Suplier", "The Supplier", "Typo.")),
  ]);
  await addin.gotoTaskpane({
    documentText: "The Suplier shall deliver the goods.",
    staleInsertedRangeOriginals: ["The Suplier"],
  });
  await addin.expectAuthedShell();
  await chooseEditMode(page);

  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([
      { text: "The Supplier", location: "After", original: "The Suplier" },
    ]);
  await expect(page.locator("body")).not.toContainText("GeneralException");
});

test("a change Word cannot scroll to reports plain language, not a Word error code", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(replacementEdit("The Suplier", "The Supplier", "Typo.")),
  ]);
  await addin.gotoTaskpane({
    documentText: "The Suplier shall deliver the goods.",
    unselectableOriginals: ["The Suplier"],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(
    page.getByText("Word couldn’t scroll to this proposed change."),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("GeneralException");

  // A failed jump is navigation trouble, not a lifecycle change: the proposal
  // is still ready to apply.
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("Tracked change ready for review")).toHaveCount(
    0,
  );
});

test("stopping a stream leaves sealed edits reviewable and marks its tail incomplete", async ({
  addin,
  page,
}) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (
        !new URL(requestUrl, window.location.href).pathname.endsWith(
          "/word-chat",
        )
      ) {
        return originalFetch(input, init);
      }

      const encoder = new TextEncoder();
      const event = (text: string): Uint8Array =>
        encoder.encode(
          `data: ${JSON.stringify({ type: "content_delta", text })}\n\n`,
        );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            event(
              '<EDITS>[{"type":"edit_data","kind":"edit",' +
                '"deleted_text":"The Suplier","inserted_text":' +
                '"The Supplier","reason":"Typo."},{"type":"edit_data",' +
                '"kind":"edit","deleted_text":"goods",' +
                '"inserted_text":"the',
            ),
          );
          init?.signal?.addEventListener(
            "abort",
            () =>
              controller.error(
                new DOMException("The request was aborted.", "AbortError"),
              ),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof window.fetch;
  });

  await addin.gotoTaskpane({
    documentText: "The Suplier will deliver goods tomorrow.",
  });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Fix the document");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeEnabled();
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  await expect(page.getByText("Receiving change…")).toHaveCount(0);
  await expect(page.getByText("the", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(
    page.getByText("Incomplete change — not applied."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
});

test("Accept all resolves every pending tracked-change handle", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(
      replacementEdit("The Suplier", "The Supplier", "Typo."),
      replacementEdit(
        "shall deliver goods",
        "shall deliver the goods",
        "Missing article.",
      ),
    ),
  ]);
  await addin.gotoTaskpane({
    documentText: "The Suplier shall deliver goods to the Buyer.",
  });
  await addin.expectAuthedShell();
  await chooseEditMode(page);

  await page.getByPlaceholder("How can I help?").fill("Fix both issues");
  await page.getByRole("button", { name: "Send" }).click();

  const acceptAll = page.getByRole("button", { name: "Accept all" });
  await expect(acceptAll).toBeEnabled();
  await acceptAll.click();

  await expect(page.locator('[data-edit-status="accepted"]')).toHaveCount(2);
  await expect(page.getByText("Accepted.", { exact: true })).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await expect(acceptAll).toHaveCount(0);

  await expect
    .poll(async () => (await addin.wordCalls()).acceptedChanges)
    .toEqual([
      { text: "The Supplier", location: "After", original: "The Suplier" },
      {
        text: "shall deliver the goods",
        location: "After",
        original: "shall deliver goods",
      },
    ]);
  const calls = await addin.wordCalls();
  expect(calls.rejectedChanges).toEqual([]);
});

test("skips an edit whose target already contains an unrelated tracked revision", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(replacementEdit("The Suplier", "The Supplier", "Typo.")),
  ]);
  await addin.gotoTaskpane({
    documentText: "The Suplier shall deliver the goods.",
    existingTrackedChangeOriginals: ["The Suplier"],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByText(
      "Skipped — the target text already has tracked changes. Accept & apply resolves them, then applies this change.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept all" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject all" })).toHaveCount(0);

  const calls = await addin.wordCalls();
  expect(calls.trackedChanges).toEqual([]);
  expect(calls.acceptedChanges).toEqual([]);
  expect(calls.rejectedChanges).toEqual([]);
});

test("explains when an edit's source text is missing from the document", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(replacementEdit("The Suplier", "The Supplier", "Typo.")),
  ]);
  await addin.gotoTaskpane({
    documentText: "The Buyer shall deliver the goods.",
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByText(
      "Skipped — the source text could not be found in the document.",
    ),
  ).toBeVisible();
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
});

test("explains when an edit's source passage cannot be safely searched", async ({
  addin,
  page,
}) => {
  const oversizedSource = "x".repeat(256);
  await addin.mockChatStream([
    wordEdits(
      replacementEdit(
        oversizedSource,
        "Short passage",
        "Condense the passage.",
      ),
    ),
  ]);
  await addin.gotoTaskpane({ documentText: oversizedSource });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Condense the passage");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByText("Incomplete change — not applied."),
  ).toBeVisible();
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
});

test("keeps an edit reviewable through its passage when Word withholds revision proxies", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(replacementEdit("The Suplier", "The Supplier", "Typo.")),
  ]);
  await addin.gotoTaskpane({
    documentText: "The Suplier will deliver the goods.",
    unmanagedTrackedChangeOriginals: ["The Suplier"],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  await page.getByRole("button", { name: "Apply", exact: true }).click();

  // Word exposed no revision proxies, but the edited passage is still tracked,
  // so the card stays actionable instead of deferring to Word's Review tab.
  const view = page.getByRole("button", { name: "View", exact: true });
  await expect(view).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Applied in Word — review it from Word’s Review tab."),
  ).toHaveCount(0);
  expect((await addin.wordCalls()).trackedChanges).toEqual([
    { text: "The Supplier", location: "After", original: "The Suplier" },
  ]);

  await view.click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([
      { text: "The Supplier", location: "After", original: "The Suplier" },
    ]);

  // Resolution re-reads the passage; its ranges report nothing here, so the
  // decision falls through to the document-level collection — which is
  // exactly how Word for the web behaves — and still resolves only this
  // edit's Added/Deleted pair.
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  const calls = await addin.wordCalls();
  expect(calls.acceptedChanges).toEqual([
    { text: "The Supplier", location: "After", original: "The Suplier" },
  ]);
  expect(calls.rejectedChanges).toEqual([]);
});

test("edits sharing replacement text resolve independently by location", async ({
  addin,
  page,
}) => {
  // Two different typos, one identical correction: both pending revisions
  // carry the same Added text, and the host (like Word on the web) withholds
  // revision proxies, so resolution goes through the document-level
  // collection. Text alone cannot tell the two Added halves apart — this
  // errored with "The revisions in this passage changed…" before location
  // narrowing through the retained anchors.
  await addin.mockChatStream([
    wordEdits(replacementEdit("teh Buyer", "the Buyer", "Fix the typo.")),
  ]);
  await addin.gotoTaskpane({
    documentText:
      "First teh Buyer pays the deposit.\nThen hte Buyer signs the lease.",
    unmanagedTrackedChangeOriginals: ["teh Buyer", "hte Buyer"],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the first typo");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();

  await addin.mockChatStream([
    wordEdits(replacementEdit("hte Buyer", "the Buyer", "Fix the typo.")),
  ]);
  await page.getByPlaceholder("How can I help?").fill("Fix the second typo");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(2);

  // Accept the FIRST edit while the second's identical Added text is still
  // pending — the collision the location narrowing exists for.
  await page
    .getByRole("button", { name: "Accept", exact: true })
    .first()
    .click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  await expect(page.getByText(/revisions in this passage changed/)).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toHaveCount(2);

  const calls = await addin.wordCalls();
  expect(calls.acceptedChanges).toEqual([
    { text: "the Buyer", location: "After", original: "teh Buyer" },
    { text: "the Buyer", location: "After", original: "hte Buyer" },
  ]);
  expect(calls.rejectedChanges).toEqual([]);
});

test("does not broaden one edit across repeated exact passages", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(
      replacementEdit("the Supplier", "Supplier Ltd.", "Clarify the entity."),
    ),
  ]);
  await addin.gotoTaskpane({
    documentText:
      "The Buyer will notify the Supplier. Later, the Supplier will respond.",
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Clarify the supplier");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByText(
      "Skipped — this text appears 2 times in the document. Tell Mike which one to change.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  const calls = await addin.wordCalls();
  expect(calls.searches).toBeGreaterThan(0);
  expect(calls.trackedChanges).toEqual([]);
});

test("an applied card names the paragraph the change landed in", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    wordEdits(
      replacementEdit(
        "notify the Supplier",
        "notify Supplier Ltd.",
        "Clarify the entity.",
      ),
    ),
  ]);
  await addin.gotoTaskpane({
    documentText:
      "Introduction\nThe Buyer will notify the Supplier before Friday.",
    documentBlocks: [
      { text: "Introduction", styleBuiltIn: "Heading1" },
      { text: "The Buyer will notify the Supplier before Friday." },
    ],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Clarify the supplier");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();

  // The surrounding paragraph is shown so a wrong-location match is
  // catchable before Accept.
  await expect(
    page.getByText("In: “The Buyer will notify the Supplier before Friday.”"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
});

test("plain prose answers offer no document mutation controls", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["Delaware law governs this agreement."]);
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("What law governs?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByText("Delaware law governs this agreement."),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept all" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject all" })).toHaveCount(0);
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
});

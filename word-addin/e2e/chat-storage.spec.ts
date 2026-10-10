import { test, expect } from "./support/fixtures";
import { replacementEdit, wordEdits } from "./support/editProtocol";

const TOKEN = "chat-storage-token";
const LOCAL_CHAT_ID = "9ee585c2-7e55-44fa-afc0-2ed20cc62913";
const ASSISTANT_MESSAGE_ID = "5b0a81db-df77-4c5f-83ab-f54e29057d24";

test("cloud edit resolution is persisted on the normalized edit row", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(
    [
      wordEdits(
        replacementEdit("Suplier", "Supplier", "Correct the party name."),
      ),
    ],
    {
      chatId: LOCAL_CHAT_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
    },
  );
  await addin.gotoTaskpane({
    token: TOKEN,
    documentText: "The Suplier shall deliver the goods.",
  });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Correct the typo");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeEnabled();

  const persistenceRequest = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" &&
      request
        .url()
        .includes(`/word-chat/messages/${ASSISTANT_MESSAGE_ID}/edits/0`),
  );
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  const request = await persistenceRequest;

  expect(request.postDataJSON()).toEqual({ resolution_status: "accepted" });
  expect(new URL(request.url()).searchParams.get("document_id")).toBeTruthy();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
});

test("cloud is default and local mode persists document chats in IndexedDB", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["A locally stored answer."], {
    chatId: LOCAL_CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    docReads: ["Demo Contract.docx"],
  });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();

  const cloudSwitch = page.getByRole("switch", {
    name: "Save chats in the cloud",
  });
  await expect(
    cloudSwitch.locator(
      "xpath=ancestor::div[contains(@class, 'rounded-xl')][1]",
    ),
  ).toHaveClass(/liquid-glass-flat/);
  await expect(
    page
      .getByRole("button", { name: "Delete" })
      .locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]"),
  ).toHaveClass(/liquid-glass-flat/);
  await expect(cloudSwitch).toBeChecked();
  await cloudSwitch.click();
  await expect(cloudSwitch).not.toBeChecked();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();
  await page.getByPlaceholder("How can I help?").fill("Keep this chat local");

  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const request = await requestPromise;
  const body = request.postDataJSON();
  expect(body.storage).toBe("local");
  expect(body.chat_id).toBeTruthy();
  expect(body.document_id).toBeTruthy();

  await expect(page.getByText("A locally stored answer.")).toBeVisible();
  await page.getByRole("button", { name: "Chat history" }).click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: /Keep this chat local/ }),
  ).toBeVisible();
  await menu.getByRole("menuitem", { name: /Keep this chat local/ }).click();
  await expect(
    page.getByTestId("user-message-content").getByText("Keep this chat local"),
  ).toBeVisible();
  await expect(page.getByText("A locally stored answer.")).toBeVisible();
  await page.getByRole("button", { name: "Completed in 1 step" }).click();
  await expect(page.getByText("Read", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo Contract.docx")).toBeVisible();
  const [userBox, assistantBox] = await Promise.all([
    page.getByTestId("user-message-content").boundingBox(),
    page.getByText("A locally stored answer.").boundingBox(),
  ]);
  expect(userBox).not.toBeNull();
  expect(assistantBox).not.toBeNull();
  expect(userBox!.y).toBeLessThan(assistantBox!.y);
});

test("device-only history restores accepted and rejected edit outcomes", async ({
  addin,
  page,
}) => {
  const firstOriginal = "Suplier";
  const firstReplacement = "Supplier";
  const secondOriginal = "deliver goods";
  const secondReplacement = "deliver the goods";
  const response = wordEdits(
    replacementEdit(firstOriginal, firstReplacement, "Correct the party name."),
    replacementEdit(
      secondOriginal,
      secondReplacement,
      "Add the missing article.",
    ),
  );

  await addin.mockChatStream([response], {
    chatId: "19ca5c94-0e23-4d56-8404-b3775154f8f8",
    assistantMessageId: "9a8d3cc4-a120-4ec1-886f-c7721daeb1a1",
  });
  await addin.gotoTaskpane({
    token: TOKEN,
    documentText: "The Suplier shall deliver goods to the Buyer.",
  });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Save chats in the cloud" }).click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();

  await page
    .getByPlaceholder("How can I help?")
    .fill("Correct both drafting issues");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await page
    .getByRole("button", { name: "Apply", exact: true })
    .first()
    .click();
  await expect(page.locator('[data-edit-status="pending"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator('[data-edit-status="pending"]')).toHaveCount(2);

  await page
    .locator('[data-edit-status="pending"]')
    .first()
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await expect(page.locator('[data-edit-status="accepted"]')).toHaveCount(1);
  await page
    .locator('[data-edit-status="pending"]')
    .first()
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  await expect(page.locator('[data-edit-status="rejected"]')).toHaveCount(1);

  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /Correct both drafting issues/ })
    .click();

  await expect(page.locator('[data-edit-status="accepted"]')).toHaveCount(1);
  await expect(page.locator('[data-edit-status="rejected"]')).toHaveCount(1);
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  await expect(page.getByText("Rejected.", { exact: true })).toBeVisible();
  await expect(page.getByText("Historical change.")).toHaveCount(0);
});

test("stopping a local edit stream preserves the assistant turn for reload", async ({
  addin,
  page,
}) => {
  const original = "The Suplier shall deliver the goods.";
  const replacement = "The Supplier shall deliver the goods.";
  const chatId = "7c1d920b-12f0-45cb-b121-ead5fb1b1241";
  const assistantMessageId = "70d0d343-4de8-4d33-88d4-a9f117e1c3f0";
  const redline = wordEdits(
    replacementEdit(original, replacement, "Correct the party name."),
  );

  await page.addInitScript(
    ({ persistedChatId, persistedAssistantId, streamedRedline }) => {
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
              frame({
                type: "chat_id",
                chatId: persistedChatId,
                assistantMessageId: persistedAssistantId,
              }),
            );
            controller.enqueue(
              frame({ type: "content_delta", text: streamedRedline }),
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
    },
    {
      persistedChatId: chatId,
      persistedAssistantId: assistantMessageId,
      streamedRedline: redline,
    },
  );

  await addin.gotoTaskpane({ token: TOKEN, documentText: original });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Save chats in the cloud" }).click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();

  await page
    .getByPlaceholder("How can I help?")
    .fill("Correct the supplier typo");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => (await addin.wordDocument()).bookmarks.length)
    .toBe(1);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /Correct the supplier typo/ })
    .click();

  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
});

test("a clean SSE cancellation finalizes and persists a partial local turn", async ({
  addin,
  page,
}) => {
  const chatId = "3bcd6af0-ff49-41a0-b0a5-fac156eb650e";
  const assistantMessageId = "3c20ca34-a6db-492d-b4d1-79c86c36ffad";
  const partialRedline =
    '<EDITS>[{"type":"edit_data","kind":"edit","deleted_text":' +
    '"The Suplier shall deliver the goods.","inserted_text":"The Supplier';

  await page.addInitScript(
    ({ persistedChatId, persistedAssistantId, streamedRedline }) => {
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
              frame({
                type: "chat_id",
                chatId: persistedChatId,
                assistantMessageId: persistedAssistantId,
              }),
            );
            controller.enqueue(
              frame({ type: "content_delta", text: streamedRedline }),
            );
            // Deliberately leave the stream open. readSSE handles AbortSignal by
            // cancelling its reader, which resolves rather than throwing.
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof window.fetch;
    },
    {
      persistedChatId: chatId,
      persistedAssistantId: assistantMessageId,
      streamedRedline: partialRedline,
    },
  );

  await addin.gotoTaskpane({
    token: TOKEN,
    documentText: "The Suplier shall deliver the goods.",
  });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Save chats in the cloud" }).click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();

  await page
    .getByPlaceholder("How can I help?")
    .fill("Finish this change locally");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Receiving change…")).toHaveCount(0);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(
    page.getByText("Incomplete change — not applied."),
  ).toBeVisible();

  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /Finish this change locally/ })
    .click();

  await expect(page.getByText("Historical change.")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("<EDITS>");
});

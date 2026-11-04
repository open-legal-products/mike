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

test("a device-only save failure after a finished answer is reported as a save failure", async ({
  addin,
  page,
}) => {
  // Make IndexedDB refuse every ASSISTANT message write, as a full disk or
  // a revoked storage quota would. The user's own message still saves.
  await page.addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (
        this.name === "word-chat-messages" &&
        typeof value === "object" &&
        value !== null &&
        (value as { role?: unknown }).role === "assistant"
      ) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalPut.call(this, value, key);
    } as typeof IDBObjectStore.prototype.put;
  });
  await addin.mockChatStream(["The finished answer."], {
    chatId: LOCAL_CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Save chats in the cloud" }).click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();

  await page.getByPlaceholder("How can I help?").fill("Answer and save");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("The finished answer.")).toBeVisible();
  await expect(
    page.getByText(/wasn't saved on this device/).first(),
  ).toBeVisible();
  // Without the fix the save's rejection escaped into the turn's catch: the
  // finished answer was reported as a failed one, with a Retry that would
  // re-send the whole turn.
  await expect(page.getByText(/get a response/i)).toHaveCount(0);
  await expect(
    page.getByText("Mike couldn't finish that answer. Try again."),
  ).toHaveCount(0);
});

// ---- Device-only storage work ------------------------------------------
// Rows the pane structured-clones out of IndexedDB, per object store
// (get/getAll results and cursor steps). Opening a chat or saving a message
// must cost the rows it needs, not every row the device has accumulated.
async function countIndexedDbReads(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const reads: Record<string, number> = {};
    (window as unknown as { __IDB_READS__: Record<string, number> }).__IDB_READS__ = reads;
    for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype] as unknown as Array<Record<string, unknown>>) {
      for (const method of ["get", "getAll", "openCursor"]) {
        const original = proto[method] as (...args: unknown[]) => IDBRequest;
        proto[method] = function (this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
          const request = original.apply(this, args);
          const store = this instanceof IDBIndex ? this.objectStore.name : this.name;
          request.addEventListener("success", () => {
            const result = request.result as unknown;
            reads[store] = (reads[store] ?? 0) + (Array.isArray(result) ? result.length : result == null ? 0 : 1);
          });
          return request;
        };
      }
    }
  });
}

const idbReads = (page: import("@playwright/test").Page, store: string) =>
  page.evaluate((name) => (window as unknown as { __IDB_READS__: Record<string, number> }).__IDB_READS__[name] ?? 0, store);

/** Put rows straight into the pane's database, as months of use would. */
async function seedLocalRows(page: import("@playwright/test").Page, rows: Record<string, unknown[]>) {
  await page.evaluate((stores) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("mike-word-addin");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(Object.keys(stores), "readwrite");
      for (const [store, values] of Object.entries(stores)) for (const value of values) transaction.objectStore(store).put(value);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), rows);
}

async function firstLocalChat(page: import("@playwright/test").Page) {
  return page.evaluate(() => new Promise<{ id: string; owner_id: string; document_id: string }>((resolve, reject) => {
    const open = indexedDB.open("mike-word-addin");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction("word-chats").objectStore("word-chats").getAll();
      request.onsuccess = () => { open.result.close(); resolve(request.result[0]); };
    };
  }));
}

async function expectSavedAnswer(page: import("@playwright/test").Page, chatId: string, content: string) {
  await expect.poll(() => page.evaluate(({ chatId, content }) => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open("mike-word-addin");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("word-chat-messages");
      const request = transaction.objectStore("word-chat-messages").index("chat_id").getAll(IDBKeyRange.only(chatId));
      let saved = false;
      request.onsuccess = () => {
        saved = request.result.some((message: { role: string; content: string }) => message.role === "assistant" && message.content === content);
      };
      transaction.oncomplete = () => { database.close(); resolve(saved); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }), { chatId, content })).toBe(true);
}

async function sendLocally(addin: { gotoTaskpane(opts: object): Promise<void>; expectAuthedShell(): Promise<void> }, page: import("@playwright/test").Page, prompt: string, documentText: string) {
  await addin.gotoTaskpane({ token: TOKEN, documentText });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Save chats in the cloud" }).click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();
  await page.getByPlaceholder("How can I help?").fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
}

test("opening a device-only chat reads only that chat's edits", async ({ addin, page }) => {
  await countIndexedDbReads(page);
  await addin.mockChatStream([wordEdits(replacementEdit("Suplier", "Supplier", "Correct the party name."))], {
    chatId: LOCAL_CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  await sendLocally(addin, page, "Correct the typo", "The Suplier shall deliver the goods.");
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  const chat = await firstLocalChat(page);
  // Another chat about the same document with a long edit history.
  const otherMessageId = "other-assistant-message";
  await seedLocalRows(page, {
    "word-chats": [{ ...chat, id: "other-chat", title: "Earlier review", updated_at: "2020-01-01T00:00:00.000Z" }],
    "word-chat-messages": [{ id: otherMessageId, chat_id: "other-chat", role: "assistant", content: "", created_at: "2020-01-01T00:00:00.000Z", sequence: 0 }],
    "word-document-edits": Array.from({ length: 300 }, (_, blockIndex) => ({
      id: `${otherMessageId}:edit-${blockIndex}`, messageId: otherMessageId, blockIndex, originalText: `old ${blockIndex}`,
      replacementText: `new ${blockIndex}`, formats: [], applyMode: "approval", applyStatus: "proposed",
      document_id: chat.document_id, owner_id: chat.owner_id,
    })),
  });

  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  const before = await idbReads(page, "word-document-edits");
  await page.getByRole("menu").getByRole("menuitem", { name: /Correct the typo/ }).click();
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  expect(await idbReads(page, "word-document-edits") - before).toBe(1);

  // Deleting device-only chats still removes every chat, message and edit.
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete chats" }).click();
  await expect(page.getByRole("button", { name: "Delete chats" })).toHaveCount(0);
  expect(await page.evaluate(() => new Promise<number[]>((resolve) => {
    const open = indexedDB.open("mike-word-addin");
    open.onsuccess = () => {
      const stores = ["word-chats", "word-chat-messages", "word-document-edits"];
      const transaction = open.result.transaction(stores);
      Promise.all(stores.map((store) => new Promise<number>((done) => {
        const request = transaction.objectStore(store).count();
        request.onsuccess = () => done(request.result);
      }))).then((counts) => { open.result.close(); resolve(counts); });
    };
  }))).toEqual([0, 0, 0]);
});

const SEEDED_TURNS = 20;

test("saving into a long device-only chat does not re-read its messages", async ({ addin, page }) => {
  await countIndexedDbReads(page);
  await addin.mockChatStream(["Noted."]);
  await sendLocally(addin, page, "Start the thread", "The Supplier shall deliver the goods.");
  await expect(page.getByText("Noted.")).toHaveCount(1);
  // A chat written before the sequence counter existed, with 20 more turns,
  // seeded straight into IndexedDB. Any size fails without the counter (the
  // assertion below is exactly 0 rows); a small one keeps the reopened
  // transcript cheap to render under the development-stress CPU throttle.
  const { next_sequence: _counter, ...chat } = (await firstLocalChat(page)) as { id: string; owner_id: string; document_id: string; next_sequence?: number };
  await seedLocalRows(page, {
    "word-chats": [chat],
    "word-chat-messages": Array.from({ length: SEEDED_TURNS }, (_, i) => ({
      id: `earlier-${i}`, chat_id: chat.id, role: i % 2 ? "assistant" : "user", content: `Earlier turn ${i}`,
      created_at: "2020-01-01T00:00:00.000Z", sequence: i + 2,
    })),
  });
  const countMessages = () => page.evaluate(() => new Promise<number>((resolve) => {
    const open = indexedDB.open("mike-word-addin");
    open.onsuccess = () => {
      const request = open.result.transaction("word-chat-messages").objectStore("word-chat-messages").count();
      request.onsuccess = () => { open.result.close(); resolve(request.result); };
    };
  }));

  await addin.reloadTaskpane();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: /Start the thread/ }).click();
  await expect(page.getByText(`Earlier turn ${SEEDED_TURNS - 2}`, { exact: true })).toBeVisible();
  const before = await idbReads(page, "word-chat-messages");
  await page.getByPlaceholder("How can I help?").fill("Latest question");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Noted.")).toHaveCount(2);
  await expect.poll(countMessages).toBe(SEEDED_TURNS + 4);
  // Two saves (question, answer); each probes its own id, which is new.
  expect(await idbReads(page, "word-chat-messages") - before).toBe(0);

  await addin.reloadTaskpane();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: /Start the thread/ }).click();
  // Wait for every user message of the reopened transcript (the first one,
  // the 10 seeded, the latest) before reading the last, so the assertion
  // checks ordering rather than racing the render.
  const userMessages = page.getByTestId("user-message-content");
  await expect(userMessages).toHaveCount(2 + SEEDED_TURNS / 2);
  await expect(userMessages.last()).toHaveText("Latest question");
});

for (const version of [4, 5]) test(`device-only history preserves a version ${version} database`, async ({ addin, page }) => {
  await countIndexedDbReads(page);
  await addin.mockChatStream(["Noted."]);
  await sendLocally(addin, page, "Newest question", "The Supplier shall deliver the goods.");
  const chat = await firstLocalChat(page);
  // Finish the setup turn before replacing its database with a legacy fixture.
  await expectSavedAnswer(page, chat.id, "Noted.");
  // Version 4 is the released schema; version 5 was used by PR previews.
  // Opening either must preserve its version, rows and ordering.
  await page.evaluate(({ current, olderCount, version }) => new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase("mike-word-addin");
    deletion.onerror = () => reject(deletion.error);
    deletion.onsuccess = () => {
      const open = indexedDB.open("mike-word-addin", version);
      open.onupgradeneeded = () => {
        const database = open.result;
        const chats = database.createObjectStore("word-chats", { keyPath: "id" });
        chats.createIndex("document_id", "document_id", { unique: false });
        chats.createIndex("owner_document", ["owner_id", "document_id"], { unique: false });
        if (version === 5) chats.createIndex("owner_document_updated", ["owner_id", "document_id", "updated_at"]);
        database.createObjectStore("word-chat-messages", { keyPath: "id" }).createIndex("chat_id", "chat_id", { unique: false });
        const edits = database.createObjectStore("word-document-edits", { keyPath: "id" });
        edits.createIndex("message_id", "messageId", { unique: false });
        edits.createIndex("owner_document", ["owner_id", "document_id"], { unique: false });
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction("word-chats", "readwrite");
        const store = transaction.objectStore("word-chats");
        store.put(current);
        for (let i = 0; i < olderCount; i++) {
          store.put({ ...current, id: `older-${i}`, title: `Older chat ${i}`, updated_at: `2020-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
        }
        transaction.oncomplete = () => { open.result.close(); resolve(); };
      };
    };
  }), { current: chat, olderCount: 25, version });

  // The reload resets the read counters; the history list loads on mount.
  await addin.reloadTaskpane();
  await page.getByRole("button", { name: "Chat history" }).click();
  const list = page.getByTestId("chat-history-list-10");
  const expected = ["Newest question", ...Array.from({ length: 19 }, (_, i) => `Older chat ${24 - i}`)];
  await expect(list.getByRole("menuitem")).toHaveCount(10);
  // About one page: pageSize + 1 rows (the extra one only answers "has
  // more"), never the document's 26 chats.
  if (version === 5) expect(await idbReads(page, "word-chats")).toBeLessThanOrEqual(12);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(list.getByRole("menuitem")).toHaveCount(20);
  expect(await list.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.textContent ?? ""))).toEqual(
    expected.map((title) => expect.stringContaining(title)),
  );
  // Page two costs about one more page: advance() skips page one unread.
  if (version === 5) expect(await idbReads(page, "word-chats")).toBeLessThanOrEqual(24);

  // Simulate a still-open older pane saving its in-flight answer. It opens
  // the released version explicitly and rewrites chat rows without the new
  // counter, exactly as the old storage code does.
  await page.evaluate(({ current, version }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("mike-word-addin", version);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction(["word-chats", "word-chat-messages"], "readwrite");
      const { next_sequence: _counter, ...legacyChat } = current as typeof current & { next_sequence?: number };
      transaction.objectStore("word-chats").put(legacyChat);
      transaction.objectStore("word-chat-messages").put({
        id: "legacy-inflight-answer", chat_id: current.id, role: "assistant", content: "Answer saved by the older pane.",
        events: [{ type: "content", text: "Answer saved by the older pane." }],
        sequence: 0, created_at: new Date().toISOString(),
      });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }), { current: chat, version });
  await list.getByRole("menuitem", { name: /Newest question/ }).click();
  await expect(page.getByText("Answer saved by the older pane.", { exact: true })).toBeVisible();
  await page.getByPlaceholder("How can I help?").fill("Continue after the older pane");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Noted.", { exact: true })).toBeVisible();
  // Streamed text is visible before the terminal IndexedDB transaction. This
  // tests reopening a saved answer, so assert its durable write before reload.
  await expectSavedAnswer(page, chat.id, "Noted.");
  await addin.reloadTaskpane();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page.getByRole("menuitem", { name: /Newest question/ }).click();
  await expect(page.getByText("Answer saved by the older pane.", { exact: true })).toBeVisible();
  await expect(page.getByText("Noted.", { exact: true })).toBeVisible();
});

test("an add-in older than the device-only database says to reopen it", async ({ addin, page }) => {
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  // A newer build already upgraded this device's database past this bundle.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase("mike-word-addin");
    deletion.onsuccess = () => {
      const open = indexedDB.open("mike-word-addin", 99);
      open.onupgradeneeded = () => open.result.createObjectStore("word-chats", { keyPath: "id" });
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    };
  }));
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Save chats in the cloud" }).click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();
  await page.getByRole("button", { name: "Chat history" }).click();
  await expect(page.getByText(/Close and reopen the add-in to load them/).first()).toBeVisible();
});

import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

const TOKEN = "history-test-token";

function makeChats(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `chat-${index + 1}`,
    project_id: null,
    user_id: "user-1",
    title: `Chat ${index + 1}`,
    created_at: new Date(Date.now() - (index + 1) * 10 * 60_000).toISOString(),
  }));
}

async function mockPaginatedHistory(
  page: Page,
  count: number,
  requests: { limit: number; offset: number }[],
): Promise<void> {
  const chats = makeChats(count);
  await page.route("**/word-chat?*", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    const params = new URL(request.url()).searchParams;
    if (!params.has("document_id")) return route.fallback();
    const limit = Number(params.get("limit"));
    const offset = Number(params.get("offset") ?? 0);
    requests.push({ limit, offset });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(chats.slice(offset, offset + limit)),
    });
  });
}

test("header dropdown loads 10 chats and fetches 10 more at the bottom", async ({
  addin,
  page,
}) => {
  const requests: { limit: number; offset: number }[] = [];
  await mockPaginatedHistory(page, 35, requests);
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  await expect.poll(() => requests).toEqual([{ limit: 11, offset: 0 }]);
  await page.getByRole("button", { name: "Chat history" }).click();
  const dropdown = page.getByRole("menu");
  await expect(dropdown).toHaveCSS("height", "360px");
  await expect(dropdown.getByText("Chat History", { exact: true })).toHaveCount(
    0,
  );
  const search = dropdown.getByPlaceholder("Search recent chats...");
  await expect(search).toBeVisible();
  const list = page.getByTestId("chat-history-list-10");
  await expect(list.getByRole("button")).toHaveCount(10);
  await expect(list.getByRole("button", { name: /Chat 1.*10m/ })).toBeVisible();
  expect(requests).toEqual([{ limit: 11, offset: 0 }]);

  await search.fill("Chat 3");
  await expect(list.getByRole("button", { name: /Chat 3/ })).toBeVisible();
  await expect(list.getByRole("button")).toHaveCount(1);
  await search.clear();

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });

  await expect.poll(() => requests).toContainEqual({ limit: 11, offset: 10 });
  await expect(list.getByRole("button")).toHaveCount(20);
});

test("Chat History page searches and loads 20 more chats at the bottom", async ({
  addin,
  page,
}) => {
  const requests: { limit: number; offset: number }[] = [];
  await mockPaginatedHistory(page, 45, requests);
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Open menu" }).click();
  const menuItems = page.getByRole("menuitem");
  await expect(menuItems.nth(0)).toHaveText("Assistant");
  await expect(menuItems.nth(1)).toHaveText("Chat History");
  const historyItem = page.getByRole("menuitem", { name: "Chat History" });
  await expect(historyItem.locator("img")).toHaveCount(1);
  await historyItem.click();

  await expect(page.getByTestId("chat-history-page-title")).toHaveText(
    "Chat History",
  );
  await expect(page.getByTestId("chat-history-page-title")).toHaveClass(
    /font-serif/,
  );
  const newChatButton = page
    .getByTestId("floating-header")
    .getByRole("button", { name: "New chat" });
  await expect(newChatButton).toBeVisible();
  const list = page.getByTestId("chat-history-list-20");
  await expect(list.getByRole("button")).toHaveCount(20);
  expect(requests).toEqual([
    { limit: 11, offset: 0 },
    { limit: 21, offset: 0 },
  ]);

  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });

  await expect
    .poll(() => requests)
    .toEqual([
      { limit: 11, offset: 0 },
      { limit: 21, offset: 0 },
      { limit: 21, offset: 20 },
    ]);
  await expect(list.getByRole("button")).toHaveCount(40);

  await page.getByPlaceholder("Search chat history...").fill("Chat 37");
  await expect(list.getByRole("button", { name: /Chat 37/ })).toBeVisible();
  await expect(list.getByRole("button")).toHaveCount(1);

  await newChatButton.click();
  await expect(page.getByText("Quick actions", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("floating-header").getByRole("button", {
      name: "New chat",
    }),
  ).toHaveCount(0);
});

test("history reports a failed request and retries it", async ({
  addin,
  page,
}) => {
  let attempts = 0;
  await page.route("**/word-chat?*", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    const params = new URL(request.url()).searchParams;
    if (!params.has("document_id")) return route.fallback();
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "History temporarily unavailable" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeChats(1)),
    });
  });

  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();

  const dropdown = page.getByRole("menu");
  // The 503 body is not echoed; the classified outage sentence is shown.
  await expect(dropdown.getByRole("alert")).toContainText(
    "Mike is temporarily unavailable",
  );
  await dropdown.getByRole("button", { name: "Retry" }).click();
  await expect(dropdown.getByRole("button", { name: /Chat 1/ })).toBeVisible();
  expect(attempts).toBe(2);
});

test("a dismissed history load cannot replace a newer chat selection", async ({
  addin,
  page,
}) => {
  const requests: { limit: number; offset: number }[] = [];
  await mockPaginatedHistory(page, 2, requests);

  let firstDetailRequested = false;
  let releaseFirstDetail: () => void = () => {
    throw new Error("First history detail request was not initialized.");
  };
  const firstDetailGate = new Promise<void>((resolve) => {
    releaseFirstDetail = resolve;
  });
  await page.route("**/word-chat/chat-1?*", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    firstDetailRequested = true;
    await firstDetailGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        chat: makeChats(1)[0],
        messages: [
          {
            id: "stale-user",
            role: "user",
            content: "Stale stored question",
          },
        ],
      }),
    });
  });
  await page.route("**/word-chat/chat-2?*", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        chat: makeChats(2)[1],
        messages: [
          {
            id: "current-user",
            role: "user",
            content: "Current stored question",
          },
        ],
      }),
    });
  });

  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: /Chat 1/ })
    .click();
  await expect.poll(() => firstDetailRequested).toBe(true);

  // Dismissing the dropdown invalidates its pending detail request. A newly
  // opened dropdown may then select a different chat while the first network
  // response is still outstanding.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: /Chat 2/ })
    .click();
  await expect(page.getByText("Current stored question")).toBeVisible();

  const staleResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/word-chat/chat-1"),
  );
  releaseFirstDetail();
  await staleResponse;
  await page.waitForTimeout(50);

  await expect(page.getByText("Current stored question")).toBeVisible();
  await expect(page.getByText("Stale stored question")).toHaveCount(0);
});

test("persisted cloud failures and cancellations both refresh history", async ({
  addin,
  page,
}) => {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      __WORD_HISTORY_EVENT_COUNT__?: number;
    };
    testWindow.__WORD_HISTORY_EVENT_COUNT__ = 0;
    window.addEventListener("mike-word-chat-history-changed", () => {
      testWindow.__WORD_HISTORY_EVENT_COUNT__ =
        (testWindow.__WORD_HISTORY_EVENT_COUNT__ ?? 0) + 1;
    });

    const originalFetch = window.fetch.bind(window);
    let requestCount = 0;
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

      requestCount += 1;
      const encoder = new TextEncoder();
      const frame = (value: unknown): Uint8Array =>
        encoder.encode(`data: ${JSON.stringify(value)}\n\n`);

      if (requestCount === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                frame({
                  type: "chat_id",
                  chatId: "failed-cloud-chat",
                  assistantMessageId: "failed-cloud-assistant",
                }),
              );
              controller.enqueue(
                frame({ type: "content_delta", text: "Partial answer." }),
              );
              controller.enqueue(
                frame({ type: "error", message: "Persisted stream failure" }),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              frame({
                type: "chat_id",
                chatId: "failed-cloud-chat",
                assistantMessageId: "cancelled-cloud-assistant",
              }),
            );
            // Stay open: AbortSignal makes readSSE cancel its reader normally.
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof window.fetch;
  });

  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  const composer = page.getByPlaceholder("How can I help?");
  await composer.fill("Fail after persistence");
  await page.getByRole("button", { name: "Send" }).click();
  // The backend's terminal error frame is written for the user, so it shows
  // verbatim — without the old "Error: " prefix. `.first()` because the toast
  // that carries the Retry is an alert too.
  await expect(page.getByRole("alert").first()).toHaveText(
    "Persisted stream failure",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __WORD_HISTORY_EVENT_COUNT__?: number;
            }
          ).__WORD_HISTORY_EVENT_COUNT__ ?? 0,
      ),
    )
    .toBe(1);

  await composer.fill("Cancel this response");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __WORD_HISTORY_EVENT_COUNT__?: number;
            }
          ).__WORD_HISTORY_EVENT_COUNT__ ?? 0,
      ),
    )
    .toBe(2);
});

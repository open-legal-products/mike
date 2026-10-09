/**
 * Server-owned Word turns: the answer belongs to the backend, not to the
 * pane's socket.
 *
 * The pane no longer cancels by dropping its stream (that would only detach
 * it while the server kept answering), a dropped connection is rejoined from
 * the last frame applied, and a chat whose answer is still running attaches
 * to it when it opens — tool calls included.
 */
import { test, expect } from "./support/fixtures";
import type { Page, Request } from "@playwright/test";

const TOKEN = "server-owned-turns-token";
const CHAT_ID = "1f0e19cf-9be0-4b53-a1c4-2f2ffb92e600";
const TURN_ID = "2f0e19cf-9be0-4b53-a1c4-2f2ffb92e601";
const TOOL_CALL_ID = "3f0e19cf-9be0-4b53-a1c4-2f2ffb92e602";
const TURN_STREAM_GLOB = "**/word-chat/*/turn/*/stream*";
const TURN_STOP_GLOB = "**/word-chat/*/turn/*/stop*";
const TOOL_RESULT_GLOB = "**/word-chat/tool-result";

const sse = (
  frames: { seq?: number; data: unknown }[],
  opts: { done?: boolean } = {},
): string => {
  let body = "";
  for (const frame of frames) {
    if (frame.seq !== undefined) body += `id: ${frame.seq}\n`;
    body += `data: ${JSON.stringify(frame.data)}\n\n`;
  }
  if (opts.done !== false) body += "data: [DONE]\n\n";
  return body;
};

const eventStream = (body: string) => ({
  status: 200,
  headers: {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  },
  body,
});

/**
 * A POST /word-chat that identifies the turn, streams half an answer, and
 * then ends WITHOUT `[DONE]` — a dropped connection, which the pane must
 * treat as a transport failure rather than the end of the answer.
 */
async function mockDroppedSend(page: Page): Promise<void> {
  await page.route("**/word-chat", async (route, request) => {
    if (request.method() !== "POST") return route.fallback();
    return route.fulfill(
      eventStream(
        sse(
          [
            {
              seq: 1,
              data: { type: "chat_id", chatId: CHAT_ID, turnId: TURN_ID },
            },
            {
              seq: 2,
              data: { type: "content_delta", text: "Half an answer" },
            },
          ],
          { done: false },
        ),
      ),
    );
  });
}

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

test("rejoins a dropped stream from the frame after the last one applied", async ({
  addin,
  page,
}) => {
  await mockDroppedSend(page);
  const resumeUrls: string[] = [];
  await page.route(TURN_STREAM_GLOB, async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    resumeUrls.push(request.url());
    return route.fulfill(
      eventStream(
        sse([
          {
            seq: 3,
            data: { type: "content_delta", text: " and the rest." },
          },
        ]),
      ),
    );
  });

  await addin.gotoTaskpane();
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Summarise this");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("Half an answer and the rest.")).toBeVisible({
    timeout: 15_000,
  });
  expect(resumeUrls).toHaveLength(1);
  const resumed = new URL(resumeUrls[0] as string);
  expect(resumed.pathname).toContain(`/word-chat/${CHAT_ID}/turn/${TURN_ID}/`);
  // Frames 1 and 2 were applied, so the pane asks for everything from 3.
  expect(resumed.searchParams.get("from")).toBe("3");
  expect(resumed.searchParams.get("document_id")).toBeTruthy();
});

test("Stop posts to the stop endpoint instead of dropping the connection", async ({
  addin,
  page,
}) => {
  await mockDroppedSend(page);
  // The rejoin never answers, so the turn stays live and Stop stays offered.
  await page.route(TURN_STREAM_GLOB, async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    await new Promise(() => {});
  });
  const stopRequests: Request[] = [];
  await page.route(TURN_STOP_GLOB, async (route, request) => {
    if (request.method() !== "POST") return route.fallback();
    stopRequests.push(request);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ stopped: true, finished: false }),
    });
  });

  await addin.gotoTaskpane();
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Take your time");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Half an answer")).toBeVisible({
    timeout: 15_000,
  });

  const stop = page.getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await stop.click();

  await expect.poll(() => stopRequests.length).toBe(1);
  const stopped = new URL((stopRequests[0] as Request).url());
  expect(stopped.pathname).toBe(
    `/api/word-chat/${CHAT_ID}/turn/${TURN_ID}/stop`,
  );
  expect(stopped.searchParams.get("document_id")).toBeTruthy();
  // The partial answer stays on screen: the server stored it too.
  await expect(page.getByText("Half an answer")).toBeVisible();
});

/** History list + detail for one cloud chat whose answer is still running. */
async function mockChatStillAnswering(
  page: Page,
  opts: { activeTurn?: boolean } = {},
): Promise<void> {
  const chat = {
    id: CHAT_ID,
    project_id: null,
    user_id: "user-1",
    title: "Unfinished answer",
    created_at: new Date().toISOString(),
  };
  await page.route("**/word-chat?*", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([chat]),
    });
  });
  await page.route(`**/word-chat/${CHAT_ID}?*`, async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        chat,
        // The reserved assistant row is filtered out server-side, so the
        // transcript ends on the user's turn and the answer is only here.
        messages: [
          {
            id: "m-1",
            role: "user",
            content: "Summarise this",
            created_at: new Date().toISOString(),
          },
        ],
        ...(opts.activeTurn === false
          ? { active_turn: null }
          : {
              active_turn: {
                id: TURN_ID,
                seq: 2,
                assistant_message_id: "m-2",
              },
            }),
      }),
    });
  });
}

async function openChatFromHistory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByTestId("chat-history-list-10")
    .getByRole("button", { name: /Unfinished answer/ })
    .click();
}

test("opening a chat whose answer is still running attaches to it", async ({
  addin,
  page,
}) => {
  await mockChatStillAnswering(page);
  const resumeUrls: string[] = [];
  await page.route(TURN_STREAM_GLOB, async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    resumeUrls.push(request.url());
    return route.fulfill(
      eventStream(
        sse([
          {
            seq: 3,
            data: { type: "content_delta", text: "Still answering." },
          },
        ]),
      ),
    );
  });

  await addin.gotoTaskpane();
  await addin.expectAuthedShell();
  await openChatFromHistory(page);

  await expect(page.getByText("Summarise this")).toBeVisible();
  await expect(page.getByText("Still answering.")).toBeVisible({
    timeout: 15_000,
  });
  expect(resumeUrls).toHaveLength(1);
  // The stored transcript has the user turn and nothing else, so the replay
  // starts at the first frame.
  expect(new URL(resumeUrls[0] as string).searchParams.get("from")).toBe("1");
});

test("executes a client tool call replayed to a reattached pane exactly once", async ({
  addin,
  page,
}) => {
  await mockChatStillAnswering(page);
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  const toolResults: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/word-chat/tool-result")
    ) {
      toolResults.push(request.postDataJSON());
    }
  });
  await page.route(TURN_STREAM_GLOB, async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    return route.fulfill(
      eventStream(
        sse([
          {
            seq: 1,
            data: {
              type: "doc_read_start",
              filename: "Active Word document (live)",
            },
          },
          {
            seq: 2,
            data: {
              type: "client_tool_call",
              tool_call_id: TOOL_CALL_ID,
              name: "read_active_document",
              input: {},
            },
          },
          {
            seq: 3,
            data: { type: "content_delta", text: "Read it." },
          },
        ]),
      ),
    );
  });

  await addin.gotoTaskpane({ documentText: "The Supplier shall deliver." });
  await addin.expectAuthedShell();
  await openChatFromHistory(page);

  await expect(page.getByText("Read it.")).toBeVisible({ timeout: 15_000 });
  // The pane that reattached answered the pending call, and answered it once:
  // a second execution would read (or edit) the document twice.
  await expect.poll(() => toolResults.length).toBe(1);
  expect(toolResults[0]).toMatchObject({ tool_call_id: TOOL_CALL_ID });
  expect(
    (toolResults[0] as { result?: { document?: string } }).result?.document,
  ).toContain("The Supplier shall deliver.");
});

test("a finished local turn is not advertised as running when the chat is reopened", async ({
  addin,
  page,
}) => {
  // A local chat records its running turn id in IndexedDB when the `chat_id`
  // frame names it, and clears it when the turn ends. The two writes used to
  // be independent transactions, so on a short turn the clear could commit
  // before the set and leave the finished id behind; the next open of the
  // chat then tried to resume a dead run. The clear now chains behind the
  // set, so reopening a finished local chat must never ask the server for a
  // turn stream.
  const LOCAL_CHAT_ID = "4f0e19cf-9be0-4b53-a1c4-2f2ffb92e603";
  const resumeUrls: string[] = [];
  await page.route(TURN_STREAM_GLOB, async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    resumeUrls.push(request.url());
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "turn_not_found" }) });
  });
  await addin.mockChatStream(["Done in one frame."], {
    chatId: LOCAL_CHAT_ID,
    turnId: TURN_ID,
    assistantMessageId: "m-local-1",
  });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const cloudSwitch = page.getByRole("switch", { name: "Save chats in the cloud" });
  await cloudSwitch.click();
  await expect(cloudSwitch).not.toBeChecked();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();

  for (let round = 0; round < 3; round += 1) {
    await page.getByPlaceholder("How can I help?").fill(`Quick local question ${round}`);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Done in one frame.").nth(round)).toBeVisible();
  }

  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page.getByRole("menu").getByRole("button", { name: /Quick local question 0/ }).click();
  await expect(page.getByText("Done in one frame.").first()).toBeVisible();
  await page.waitForTimeout(1500);
  expect(resumeUrls).toHaveLength(0);
});

test("a local turn remains resumable after transport retries are exhausted", async ({
  addin,
  page,
}) => {
  let localChatId: string | null = null;
  await page.route("**/word-chat", async (route, request) => {
    if (request.method() !== "POST") return route.fallback();
    const body = request.postDataJSON() as { chat_id?: string };
    localChatId = body.chat_id ?? null;
    return route.fulfill(
      eventStream(
        sse(
          [
            {
              seq: 1,
              data: {
                type: "chat_id",
                chatId: localChatId,
                turnId: TURN_ID,
              },
            },
            {
              seq: 2,
              data: { type: "content_delta", text: "Half an answer" },
            },
          ],
          { done: false },
        ),
      ),
    );
  });
  let resumeCount = 0;
  await page.route(TURN_STREAM_GLOB, async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    resumeCount += 1;
    if (resumeCount <= 2) {
      return route.fulfill(eventStream(sse([], { done: false })));
    }
    return route.fulfill(
      eventStream(
        sse([
          {
            seq: 3,
            data: { type: "content_delta", text: "Recovered after reopening." },
          },
        ]),
      ),
    );
  });

  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const cloudSwitch = page.getByRole("switch", {
    name: "Save chats in the cloud",
  });
  await cloudSwitch.click();
  await expect(cloudSwitch).not.toBeChecked();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();

  await page.getByPlaceholder("How can I help?").fill("Resume this answer");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => resumeCount).toBe(2);
  await expect(
    page.getByText("Error: Chat stream ended before the completion marker."),
  ).toBeVisible();
  expect(localChatId).not.toBeNull();

  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: /Resume this answer/ })
    .click();

  await expect.poll(() => resumeCount).toBe(3);
  await expect(page.getByText("Recovered after reopening.")).toBeVisible({
    timeout: 15_000,
  });
});

/**
 * Client-executed Word tools (apply_word_edits / read_active_document).
 *
 * The backend forwards these model tool calls over the chat SSE stream as
 * `client_tool_call` frames; the pane executes them against the (mock) Word
 * document and posts per-edit outcomes to POST /word-chat/tool-result. These
 * specs pin the pane's half of that contract: capability advertisement, the
 * proposed-vs-applied outcome split between Review and Edit mode, failure
 * truthfulness, live reads, ordinal accounting, and restore.
 */
import { test, expect } from "./support/fixtures";
import type { Page, Request } from "@playwright/test";
import { replacementEdit, wordEdits } from "./support/editProtocol";

const TOKEN = "client-tool-edits-token";
const CHAT_ID = "chat-client-tools";
const ASSISTANT_MESSAGE_ID = "assistant-client-tools";
const TOOL_CALL_ID = "5f0e19cf-9be0-4b53-a1c4-2f2ffb92e601";
const TOOL_RESULT_GLOB = "**/word-chat/tool-result";
const ANCHOR_SETTINGS_KEY = "mike.wordEditAnchors.v1";
/** First card key a tool edit claims; see TOOL_EDIT_INDEX_BASE. */
const FIRST_TOOL_BLOCK_INDEX = 1000;

const ORIGINAL = "The Suplier shall deliver the goods.";
const REPLACEMENT = "The Supplier shall deliver the goods.";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

function toolResultRequest(request: Request): boolean {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname.endsWith("/word-chat/tool-result")
  );
}

async function chooseApplyMode(
  page: Page,
  mode: "Review" | "Edit",
): Promise<void> {
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: new RegExp(mode) }).click();
  await expect(page.getByTestId("edit-apply-toggle")).toHaveText(
    new RegExp(mode),
  );
}

function applyEditsCall(
  edits: Record<string, unknown>[],
  overrides: { toolCallId?: string; blockIndex?: number } = {},
) {
  return {
    toolCallId: overrides.toolCallId ?? TOOL_CALL_ID,
    name: "apply_word_edits",
    input: {
      block_index: overrides.blockIndex ?? FIRST_TOOL_BLOCK_INDEX,
      edits,
    },
  };
}

test("Review mode validates a forwarded call and reports it as proposed", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(["The supplier typo is ready for your review."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        {
          original: ORIGINAL,
          replacement: REPLACEMENT,
          reason: "Correct the supplier typo.",
        },
      ]),
    ],
  });

  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();

  const chatRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/word-chat"),
  );
  const toolResultPromise = page.waitForRequest(toolResultRequest);
  await page.getByPlaceholder("How can I help?").fill("Fix the supplier typo");
  await page.getByRole("button", { name: "Send" }).click();

  // The pane advertises the capability that makes the backend forward calls.
  const chatBody = (await chatRequestPromise).postDataJSON();
  expect(chatBody.client_tools).toBe(true);
  expect(chatBody.edit_apply_mode).toBe("approval");

  // Review is the default, so the truthful outcome is "proposed": validated,
  // queued for a human — NOT applied, and not a failure to retry.
  const toolResultBody = (await toolResultPromise).postDataJSON();
  expect(toolResultBody.tool_call_id).toBe(TOOL_CALL_ID);
  expect(toolResultBody.result.edits).toEqual([
    expect.objectContaining({ index: 0, status: "proposed", matches: 1 }),
  ]);

  // Nothing was written to the document; the card waits for Apply.
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(REPLACEMENT).first()).toBeVisible();
  await expect(
    page.getByText("Correct the supplier typo.", { exact: true }),
  ).toBeVisible();

  // The prose is not held hostage by the edit: tool edits live outside it.
  await expect(
    page.getByText("The supplier typo is ready for your review.", {
      exact: true,
    }),
  ).toBeVisible();

  // Applying it later is the ordinary review lifecycle.
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([
      expect.objectContaining({ text: REPLACEMENT, original: ORIGINAL }),
    ]);
});

test("Edit mode applies a forwarded call and reports it as applied", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(["Fixed the supplier name."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        {
          original: ORIGINAL,
          replacement: REPLACEMENT,
          reason: "Correct the supplier typo.",
        },
      ]),
    ],
  });

  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();
  await chooseApplyMode(page, "Edit");

  const toolResultPromise = page.waitForRequest(toolResultRequest);
  await page.getByPlaceholder("How can I help?").fill("Fix the supplier typo");
  await page.getByRole("button", { name: "Send" }).click();

  const toolResultBody = (await toolResultPromise).postDataJSON();
  expect(toolResultBody.result.edits).toEqual([
    expect.objectContaining({ index: 0, status: "applied", matches: 1 }),
  ]);

  // The edit landed in the document as a tracked change…
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([
      expect.objectContaining({ text: REPLACEMENT, original: ORIGINAL }),
    ]);
  // …and renders as a reviewable card.
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toBeVisible();
});

test("reports an ambiguous match without touching the document", async ({
  addin,
  page,
}) => {
  const sentence = "The party shall pay the fee.";
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(["I could not apply that change."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        {
          original: sentence,
          replacement: "The party shall pay the revised fee.",
          reason: "Update the fee clause.",
        },
      ]),
    ],
  });

  await addin.gotoTaskpane({
    documentText: `${sentence} Some filler. ${sentence}`,
  });
  await addin.expectAuthedShell();

  const toolResultPromise = page.waitForRequest(toolResultRequest);
  await page.getByPlaceholder("How can I help?").fill("Update the fee clause");
  await page.getByRole("button", { name: "Send" }).click();

  // Validation failures are failures in BOTH modes — this is what enables
  // the retry-with-a-longer-passage loop.
  const toolResultBody = (await toolResultPromise).postDataJSON();
  expect(toolResultBody.result.edits).toEqual([
    expect.objectContaining({ index: 0, status: "ambiguous", matches: 2 }),
  ]);

  await expect(
    page.getByText(
      "Skipped — this text appears 2 times in the document. Tell Mike which one to change.",
    ),
  ).toBeVisible();
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
});

test("answers read_active_document with the live document body", async ({
  addin,
  page,
}) => {
  const documentText = "Section 1. Payment terms. Section 2. Delivery.";
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(["Here is a summary."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      { toolCallId: TOOL_CALL_ID, name: "read_active_document", input: {} },
    ],
  });

  await addin.gotoTaskpane({ documentText });
  await addin.expectAuthedShell();

  const toolResultPromise = page.waitForRequest(toolResultRequest);
  await page.getByPlaceholder("How can I help?").fill("Summarize the document");
  await page.getByRole("button", { name: "Send" }).click();

  const toolResultBody = (await toolResultPromise).postDataJSON();
  expect(toolResultBody.tool_call_id).toBe(TOOL_CALL_ID);
  expect(toolResultBody.result.document).toBe(documentText);
  await expect(
    page.getByText("Here is a summary.", { exact: true }),
  ).toBeVisible();
});

test("accumulates ordinals across sequential apply_word_edits calls", async ({
  addin,
  page,
}) => {
  const SECOND_CALL_ID = "5f0e19cf-9be0-4b53-a1c4-2f2ffb92e602";
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(["Both fixes are in."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        {
          original: "teh Supplier",
          replacement: "the Supplier",
          reason: "Fix the article typo.",
        },
        {
          original: "shall delivers",
          replacement: "shall deliver",
          reason: "Fix the verb agreement.",
        },
      ]),
      applyEditsCall(
        [
          {
            original: "within 30 day",
            replacement: "within 30 days",
            reason: "Fix the plural.",
          },
        ],
        {
          toolCallId: SECOND_CALL_ID,
          blockIndex: FIRST_TOOL_BLOCK_INDEX + 2,
        },
      ),
    ],
  });

  await addin.gotoTaskpane({
    documentText:
      "By this agreement teh Supplier shall delivers the goods within 30 day.",
  });
  await addin.expectAuthedShell();
  await chooseApplyMode(page, "Edit");

  const posts: { toolCallId: string; statuses: string[] }[] = [];
  page.on("request", (request) => {
    if (!toolResultRequest(request)) return;
    const body = request.postDataJSON() as {
      tool_call_id: string;
      result: { edits: { status: string }[] };
    };
    posts.push({
      toolCallId: body.tool_call_id,
      statuses: body.result.edits.map((edit) => edit.status),
    });
  });
  await page.getByPlaceholder("How can I help?").fill("Fix all three typos");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => posts.length).toBe(2);
  expect(posts.find((p) => p.toolCallId === TOOL_CALL_ID)?.statuses).toEqual([
    "applied",
    "applied",
  ]);
  expect(posts.find((p) => p.toolCallId === SECOND_CALL_ID)?.statuses).toEqual([
    "applied",
  ]);

  // The hidden bookmark ids derive from message-wide flat ordinals; the
  // second call's edit must continue the count, not restart it.
  await expect
    .poll(async () =>
      Object.keys(
        (
          (await addin.wordDocument()).settings[ANCHOR_SETTINGS_KEY] as {
            anchors: Record<string, unknown>;
          }
        ).anchors,
      ).sort(),
    )
    .toEqual([
      `${ASSISTANT_MESSAGE_ID}:edit-${FIRST_TOOL_BLOCK_INDEX}`,
      `${ASSISTANT_MESSAGE_ID}:edit-${FIRST_TOOL_BLOCK_INDEX + 1}`,
      `${ASSISTANT_MESSAGE_ID}:edit-${FIRST_TOOL_BLOCK_INDEX + 2}`,
    ]);
  await expect(page.getByText("3 tracked changes")).toBeVisible();
});

test("persists tool edits through the canonical edit rows", async ({
  addin,
  page,
}) => {
  const puts: { blockIndex: number; body: Record<string, unknown> }[] = [];
  await page.route("**/word-chat/messages/*/edits/*?*", (route, request) => {
    if (request.method() !== "PUT") return route.fallback();
    const url = new URL(request.url());
    const match = url.pathname.match(/\/messages\/([^/]+)\/edits\/(\d+)$/);
    const blockIndex = Number(match?.[2] ?? -1);
    const body = request.postDataJSON() as Record<string, unknown>;
    puts.push({ blockIndex, body });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: `${ASSISTANT_MESSAGE_ID}:edit-${blockIndex}`,
        word_chat_message_id: ASSISTANT_MESSAGE_ID,
        block_index: blockIndex,
        original_text: body.original_text,
        replacement_text: body.replacement_text,
        formats: body.formats ?? [],
        occurrence: body.occurrence ?? null,
        reason: body.reason ?? null,
        apply_mode: body.apply_mode,
        apply_status: "proposed",
        resolution_status: null,
      }),
    });
  });
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(["Ready for review."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        {
          original: ORIGINAL,
          replacement: REPLACEMENT,
          reason: "Correct the supplier typo.",
        },
      ]),
    ],
  });

  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Fix the supplier typo");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toBeVisible();

  // Tool edits are ordinary edit rows: same endpoint, same body shape, only
  // the block index distinguishes their channel.
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]?.blockIndex).toBe(FIRST_TOOL_BLOCK_INDEX);
  expect(puts[0]?.body).toMatchObject({
    original_text: ORIGINAL,
    replacement_text: REPLACEMENT,
    reason: "Correct the supplier typo.",
    apply_mode: "approval",
  });
});

test("ignores an <EDITS> block in the prose once a tool call has arrived", async ({
  addin,
  page,
}) => {
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(
    [
      "Applying the fix.\n\n",
      // With tools active this is quoted text, not the edit channel. Scraping
      // it would double-apply the very edit the tool call already handled.
      wordEdits(replacementEdit(ORIGINAL, REPLACEMENT, "Duplicate.")),
    ],
    {
      chatId: CHAT_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      clientToolCalls: [
        applyEditsCall([
          {
            original: ORIGINAL,
            replacement: REPLACEMENT,
            reason: "Correct the supplier typo.",
          },
        ]),
      ],
    },
  );

  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();
  await chooseApplyMode(page, "Edit");
  const toolResultPromise = page.waitForRequest(toolResultRequest);
  await page.getByPlaceholder("How can I help?").fill("Fix the supplier typo");
  await page.getByRole("button", { name: "Send" }).click();
  await toolResultPromise;

  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(1);
  // Hold past any late scrape of the prose block.
  await page.waitForTimeout(1_000);
  expect((await addin.wordCalls()).trackedChanges).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(1);
});

test("posts a tool result exactly once when the call has expired (404)", async ({
  addin,
  page,
}) => {
  let postCount = 0;
  await page.route("**/word-chat/tool-result", (route, request) => {
    if (request.method() !== "POST") return route.fallback();
    postCount += 1;
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Unknown or expired tool call" }),
    });
  });
  await addin.mockChatStream(["Done."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        { original: ORIGINAL, replacement: REPLACEMENT, reason: "Typo." },
      ]),
    ],
  });
  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => postCount).toBe(1);
  // 404 means the backend moved on; a retry would be pure load. Hold past
  // the retry backoff window to prove none is scheduled.
  await page.waitForTimeout(2_500);
  expect(postCount).toBe(1);
});

test("retries a failed tool-result post once, then succeeds", async ({
  addin,
  page,
}) => {
  let postCount = 0;
  await page.route("**/word-chat/tool-result", (route, request) => {
    if (request.method() !== "POST") return route.fallback();
    postCount += 1;
    if (postCount === 1) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "boom" }),
      });
    }
    return route.fulfill({ status: 204, body: "" });
  });
  await addin.mockChatStream(["Done."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        { original: ORIGINAL, replacement: REPLACEMENT, reason: "Typo." },
      ]),
    ],
  });
  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => postCount, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(2_000);
  expect(postCount).toBe(2);
});

test("restores tool-applied cards and anchors from the persisted edit rows", async ({
  addin,
  page,
}) => {
  const chat = {
    id: CHAT_ID,
    project_id: null,
    user_id: "user-1",
    title: "Client tool edits",
    created_at: "2026-08-21T00:00:00Z",
  };
  const persistedEditId = "44444444-4444-4444-8444-444444444444";
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(["Fixed the supplier name."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        {
          original: ORIGINAL,
          replacement: REPLACEMENT,
          reason: "Correct the supplier typo.",
        },
      ]),
    ],
  });
  await addin.mockApiJson("GET", "**/word-chat?*", [chat]);
  // What the backend persists for this turn: prose content plus the
  // word_edit_ref the finalizer swapped in for the tool's placement marker,
  // and the canonical row it points at.
  await addin.mockApiJson("GET", `**/word-chat/${CHAT_ID}?*`, {
    chat,
    messages: [
      {
        id: "user-client-tools",
        chat_id: CHAT_ID,
        role: "user",
        content: "Fix the supplier typo",
        created_at: "2026-08-21T00:00:00Z",
      },
      {
        id: ASSISTANT_MESSAGE_ID,
        chat_id: CHAT_ID,
        role: "assistant",
        content: [
          { type: "word_edit_ref", edit_id: persistedEditId },
          { type: "content", text: "Fixed the supplier name." },
        ],
        edits: [
          {
            id: persistedEditId,
            word_chat_message_id: ASSISTANT_MESSAGE_ID,
            block_index: FIRST_TOOL_BLOCK_INDEX,
            original_text: ORIGINAL,
            replacement_text: REPLACEMENT,
            formats: [],
            occurrence: null,
            reason: "Correct the supplier typo.",
            apply_mode: "direct",
            apply_status: "applied",
            resolution_status: null,
            matched_occurrences: 1,
            applied_occurrences: 1,
          },
        ],
        created_at: "2026-08-21T00:00:01Z",
      },
    ],
  });

  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();
  await chooseApplyMode(page, "Edit");
  const toolResultPromise = page.waitForRequest(toolResultRequest);
  await page.getByPlaceholder("How can I help?").fill("Fix the supplier typo");
  await page.getByRole("button", { name: "Send" }).click();
  await toolResultPromise;
  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toBeVisible();

  // The anchor is keyed by the tool ordinal, so the reloaded pane finds the
  // same bookmark the live apply registered.
  const { settings } = await addin.wordDocument();
  const anchors = (
    settings[ANCHOR_SETTINGS_KEY] as { anchors: Record<string, unknown> }
  ).anchors;
  expect(Object.keys(anchors)).toEqual([
    `${ASSISTANT_MESSAGE_ID}:edit-${FIRST_TOOL_BLOCK_INDEX}`,
  ]);

  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /Client tool edits/ })
    .click();

  // The card restores through the ordinary message.edits path: reviewable
  // again, with the tracked change still resolvable through the bookmark.
  await expect(page.getByText(REPLACEMENT).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
});

test("a reloaded failed tool edit still explains itself", async ({
  addin,
  page,
}) => {
  const chat = {
    id: CHAT_ID,
    project_id: null,
    user_id: "user-1",
    title: "Ambiguous edit chat",
    created_at: "2026-08-21T00:00:00Z",
  };
  const persistedEditId = "55555555-5555-4555-8555-555555555555";
  await addin.mockApiJson("GET", "**/word-chat?*", [chat]);
  // Persisted history for a turn whose edit skipped as ambiguous: there is
  // no bookmark to restore, so the persisted outcome is the card's only
  // explanation after a reload.
  await addin.mockApiJson("GET", `**/word-chat/${CHAT_ID}?*`, {
    chat,
    messages: [
      {
        id: "user-ambiguous",
        chat_id: CHAT_ID,
        role: "user",
        content: "Update the fee clause",
        created_at: "2026-08-21T00:00:00Z",
      },
      {
        id: ASSISTANT_MESSAGE_ID,
        chat_id: CHAT_ID,
        role: "assistant",
        content: [
          { type: "content", text: "I could not apply that change." },
          { type: "word_edit_ref", edit_id: persistedEditId },
        ],
        edits: [
          {
            id: persistedEditId,
            word_chat_message_id: ASSISTANT_MESSAGE_ID,
            block_index: FIRST_TOOL_BLOCK_INDEX,
            original_text: "The party shall pay the fee.",
            replacement_text: "The party shall pay the revised fee.",
            formats: [],
            occurrence: null,
            reason: "Update the fee clause.",
            apply_mode: "approval",
            apply_status: "failed",
            resolution_status: null,
            matched_occurrences: 2,
            applied_occurrences: 0,
            error_code: "ambiguous",
            error_message: "Found 2 exact matches; no edit was applied.",
          },
        ],
        created_at: "2026-08-21T00:00:01Z",
      },
    ],
  });

  await addin.gotoTaskpane({
    documentText: "The party shall pay the fee. The party shall pay the fee.",
  });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /Ambiguous edit chat/ })
    .click();

  await expect(
    page.getByText(
      "Skipped — this text appears 2 times in the document. Tell Mike which one to change.",
    ),
  ).toBeVisible();
});

test("a proposed row whose change is already in the document restores as applied", async ({
  addin,
  page,
}) => {
  const chat = {
    id: CHAT_ID,
    project_id: null,
    user_id: "user-1",
    title: "Interrupted tool turn",
    created_at: "2026-08-21T00:00:00Z",
  };
  const persistedEditId = "66666666-6666-4666-8666-666666666666";
  await addin.mockApiJson("POST", TOOL_RESULT_GLOB, null, { status: 204 });
  await addin.mockChatStream(["Fixed the supplier name."], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    clientToolCalls: [
      applyEditsCall([
        {
          original: ORIGINAL,
          replacement: REPLACEMENT,
          reason: "Correct the supplier typo.",
        },
      ]),
    ],
  });
  await addin.mockApiJson("GET", "**/word-chat?*", [chat]);
  // The row a turn that died mid-apply leaves behind: the tracked change and
  // its bookmark are in the document, but the status write never landed, so
  // storage still says "proposed".
  await addin.mockApiJson("GET", `**/word-chat/${CHAT_ID}?*`, {
    chat,
    messages: [
      {
        id: "user-interrupted",
        chat_id: CHAT_ID,
        role: "user",
        content: "Fix the supplier typo",
        created_at: "2026-08-21T00:00:00Z",
      },
      {
        id: ASSISTANT_MESSAGE_ID,
        chat_id: CHAT_ID,
        role: "assistant",
        content: [{ type: "word_edit_ref", edit_id: persistedEditId }],
        edits: [
          {
            id: persistedEditId,
            word_chat_message_id: ASSISTANT_MESSAGE_ID,
            block_index: FIRST_TOOL_BLOCK_INDEX,
            original_text: ORIGINAL,
            replacement_text: REPLACEMENT,
            formats: [],
            occurrence: null,
            reason: "Correct the supplier typo.",
            apply_mode: "direct",
            apply_status: "proposed",
            resolution_status: null,
          },
        ],
        created_at: "2026-08-21T00:00:01Z",
      },
    ],
  });

  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();
  await chooseApplyMode(page, "Edit");
  const toolResultPromise = page.waitForRequest(toolResultRequest);
  await page.getByPlaceholder("How can I help?").fill("Fix the supplier typo");
  await page.getByRole("button", { name: "Send" }).click();
  await toolResultPromise;
  await expect
    .poll(async () => (await addin.wordDocument()).bookmarks.length)
    .toBe(1);

  const patches: Record<string, unknown>[] = [];
  await page.route("**/word-chat/messages/*/edits/*?*", (route, request) => {
    if (request.method() !== "PATCH") return route.fallback();
    patches.push(request.postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });

  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /Interrupted tool turn/ })
    .click();

  // The document is the authority. Re-validating instead would find the
  // edit's own revision, report a conflict, and offer "Accept & apply" —
  // which writes the same change a second time.
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept & apply" }),
  ).toHaveCount(0);
  // And the record is corrected so the next reload need not re-probe.
  await expect
    .poll(() => patches.map((patch) => patch.apply_status))
    .toContain("applied");
});

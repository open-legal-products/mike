/**
 * E2E coverage for `occurrence: "all"`: one edit object replaces
 * every occurrence of its original text. The client applies one occurrence
 * per pass (last revision-free match first — office-js#2800 makes forward
 * batched replacement unsafe on Word for the web) and aggregates all passes
 * under a single card whose Accept/Reject resolves every occurrence.
 */
import { test, expect } from "./support/fixtures";
import type { Addin } from "./support/fixtures";
import type { Page } from "@playwright/test";
import { replacementEdit, wordEdits } from "./support/editProtocol";

const TOKEN = "test-jwt-token";
const CHAT_ID = "chat-replace-all";
const ASSISTANT_MESSAGE_ID = "assistant-replace-all";
const PERSISTED_EDIT_ID = "44444444-4444-4444-8444-444444444444";
const DOC_TEXT =
  "Acme Corp leads the market.\nWe trust Acme Corp.\nAcme Corp wins again.";
const REPLACE_ALL_BLOCK = wordEdits(
  replacementEdit(
    "Acme Corp",
    "Acme Ltd",
    "Rename the company everywhere.",
    "all",
  ),
);
const WRITE = { text: "Acme Ltd", location: "After", original: "Acme Corp" };

const CHAT = {
  id: CHAT_ID,
  project_id: null,
  user_id: "user-1",
  title: "Replace all occurrences",
  created_at: "2026-08-19T00:00:00Z",
};

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

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

async function applyReviewProposal(page: Page): Promise<void> {
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  await expect(apply).toHaveCount(1);
  await apply.click();
}

async function mockPersistedChat(addin: Addin): Promise<void> {
  await addin.mockChatStream([REPLACE_ALL_BLOCK], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  await addin.mockApiJson("GET", "**/word-chat?*", [CHAT]);
  await addin.mockApiJson("GET", `**/word-chat/${CHAT_ID}?*`, {
    chat: CHAT,
    messages: [
      {
        id: "user-replace-all",
        chat_id: CHAT_ID,
        role: "user",
        content: "Rename Acme Corp everywhere",
        created_at: "2026-08-19T00:00:00Z",
      },
      {
        id: ASSISTANT_MESSAGE_ID,
        chat_id: CHAT_ID,
        role: "assistant",
        content: [{ type: "word_edit_ref", edit_id: PERSISTED_EDIT_ID }],
        edits: [
          {
            id: PERSISTED_EDIT_ID,
            word_chat_message_id: ASSISTANT_MESSAGE_ID,
            block_index: 0,
            original_text: "Acme Corp",
            replacement_text: "Acme Ltd",
            formats: [],
            occurrence: "all",
            reason: "Rename the company everywhere.",
            apply_mode: "approval",
            apply_status: "applied",
            resolution_status: null,
            matched_occurrences: 3,
            applied_occurrences: 3,
          },
        ],
        created_at: "2026-08-19T00:00:01Z",
      },
    ],
  });
}

test("review mode: one card applies and accepts every occurrence", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([REPLACE_ALL_BLOCK]);
  await addin.gotoTaskpane({ documentText: DOC_TEXT });
  await addin.expectAuthedShell();

  await page
    .getByPlaceholder("How can I help?")
    .fill("Replace all Acme Corp with Acme Ltd");
  await page.getByRole("button", { name: "Send" }).click();
  await applyReviewProposal(page);

  // Three occurrences change, but they stay ONE reviewable card.
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toHaveCount(1);
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([WRITE, WRITE, WRITE]);
  // The raw protocol tag never leaks into the transcript.
  await expect(page.getByText(/<occurrence>/)).toHaveCount(0);

  await accept.click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  const calls = await addin.wordCalls();
  expect(calls.acceptedChanges).toEqual([WRITE, WRITE, WRITE]);
  expect(calls.rejectedChanges).toEqual([]);
});

test("review mode: rejecting the card rejects every occurrence", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([REPLACE_ALL_BLOCK]);
  await addin.gotoTaskpane({ documentText: DOC_TEXT });
  await addin.expectAuthedShell();

  await page
    .getByPlaceholder("How can I help?")
    .fill("Replace all Acme Corp with Acme Ltd");
  await page.getByRole("button", { name: "Send" }).click();
  await applyReviewProposal(page);

  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await expect(reject).toHaveCount(1);
  await reject.click();
  await expect(page.getByText("Rejected.", { exact: true })).toBeVisible();
  const calls = await addin.wordCalls();
  expect(calls.rejectedChanges).toEqual([WRITE, WRITE, WRITE]);
  expect(calls.acceptedChanges).toEqual([]);
});

test("edit mode: every occurrence is applied immediately as tracked changes", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([REPLACE_ALL_BLOCK]);
  await addin.gotoTaskpane({ documentText: DOC_TEXT });
  await addin.expectAuthedShell();
  await chooseApplyMode(page, "Edit");

  await page
    .getByPlaceholder("How can I help?")
    .fill("Replace all Acme Corp with Acme Ltd");
  await page.getByRole("button", { name: "Send" }).click();

  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toHaveCount(1);
  const calls = await addin.wordCalls();
  expect(calls.trackedChanges).toEqual([WRITE, WRITE, WRITE]);
  expect(calls.acceptedChanges).toEqual([]);
});

test("a replace-all card survives a task-pane reload and still resolves all occurrences", async ({
  addin,
  page,
}) => {
  await mockPersistedChat(addin);
  await addin.gotoTaskpane({ documentText: DOC_TEXT });
  await addin.expectAuthedShell();

  await page
    .getByPlaceholder("How can I help?")
    .fill("Rename Acme Corp everywhere");
  await page.getByRole("button", { name: "Send" }).click();
  await applyReviewProposal(page);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(1);
  // One hidden bookmark per applied occurrence.
  await expect
    .poll(async () => (await addin.wordDocument()).bookmarks.length)
    .toBe(3);

  // Reloading destroys every Office.js proxy and React ref; only the mock
  // Word document (bookmarks, revisions, settings) survives.
  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /Replace all occurrences/ })
    .click();

  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toHaveCount(1);
  await accept.click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  expect((await addin.wordCalls()).acceptedChanges).toEqual([
    WRITE,
    WRITE,
    WRITE,
  ]);
});

import { test, expect } from "./support/fixtures";
import type { Addin, WordBookmarkSnapshot } from "./support/fixtures";
import type { Page } from "@playwright/test";
import { replacementEdit, wordEdits } from "./support/editProtocol";

const TOKEN = "tracked-edit-persistence-token";
const CHAT_ID = "chat-persistent-edit";
const ASSISTANT_MESSAGE_ID = "assistant-persistent-edit";
const STABLE_EDIT_ID = `${ASSISTANT_MESSAGE_ID}:edit-0`;
const PERSISTED_EDIT_ID = "33333333-3333-4333-8333-333333333333";
const ANCHOR_SETTINGS_KEY = "mike.wordEditAnchors.v1";
const ORIGINAL = "The Suplier shall deliver the goods.";
const REPLACEMENT = "The Supplier shall deliver the goods.";
const REDLINE = wordEdits(
  replacementEdit(ORIGINAL, REPLACEMENT, "Correct the defined party name."),
);

const CHAT = {
  id: CHAT_ID,
  project_id: null,
  user_id: "user-1",
  title: "Persistent tracked edit",
  created_at: "2026-08-09T00:00:00Z",
};

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

async function mockPersistedChat(addin: Addin): Promise<void> {
  await addin.mockChatStream([REDLINE], {
    chatId: CHAT_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  await addin.mockApiJson("GET", "**/word-chat?*", [CHAT]);
  await addin.mockApiJson("GET", `**/word-chat/${CHAT_ID}?*`, {
    chat: CHAT,
    messages: [
      {
        id: "user-persistent-edit",
        chat_id: CHAT_ID,
        role: "user",
        content: "Correct the supplier typo",
        created_at: "2026-08-09T00:00:00Z",
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
            original_text: ORIGINAL,
            replacement_text: REPLACEMENT,
            formats: [],
            occurrence: null,
            reason: "Correct the defined party name.",
            apply_mode: "approval",
            apply_status: "applied",
            resolution_status: null,
            matched_occurrences: 1,
            applied_occurrences: 1,
          },
        ],
        created_at: "2026-08-09T00:00:01Z",
      },
    ],
  });
}

async function applyPersistedEdit(
  addin: Addin,
  page: Page,
): Promise<WordBookmarkSnapshot> {
  await addin.gotoTaskpane({ documentText: ORIGINAL });
  await addin.expectAuthedShell();
  await page
    .getByPlaceholder("How can I help?")
    .fill("Correct the supplier typo");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect
    .poll(async () => (await addin.wordDocument()).bookmarks.length)
    .toBe(1);
  const [bookmark] = (await addin.wordDocument()).bookmarks;
  if (!bookmark) throw new Error("Expected Word to persist an edit bookmark");
  return bookmark;
}

async function reloadAndOpenPersistedChat(
  addin: Addin,
  page: Page,
): Promise<void> {
  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("button", { name: /Persistent tracked edit/ })
    .click();
}

test("rehydrates View from a hidden Word bookmark after the task pane reloads", async ({
  addin,
  page,
}) => {
  await mockPersistedChat(addin);
  const bookmark = await applyPersistedEdit(addin, page);

  const beforeReload = await addin.wordDocument();
  expect(bookmark.name).toMatch(/^_MikeEdit_[A-Za-z0-9_]+$/);
  expect(bookmark.name.length).toBeLessThanOrEqual(40);
  expect(bookmark.original).toBe(ORIGINAL);
  expect(bookmark.text).toBe(REPLACEMENT);
  expect(bookmark.pendingRevisionCount).toBe(2);
  expect(beforeReload.settings).toMatchObject({
    [ANCHOR_SETTINGS_KEY]: {
      version: 1,
      anchors: {
        [STABLE_EDIT_ID]: { bookmarkName: bookmark.name },
      },
    },
  });

  // Reloading destroys every Office.js proxy and React ref. Only the mock Word
  // document survives, matching a real task-pane reload in an open document.
  await reloadAndOpenPersistedChat(addin, page);
  expect((await addin.wordCalls()).searches).toBe(0);

  const view = page.getByRole("button", { name: "View", exact: true });
  await expect(view).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toBeVisible();

  const afterRestore = await addin.wordCalls();
  expect(afterRestore.searches).toBe(0);
  expect(afterRestore.bookmarkLookups).toEqual([bookmark.name]);

  await view.click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([{ text: REPLACEMENT, location: "After", original: ORIGINAL }]);
  // The exact stored range is selected; View never searches for source text.
  expect((await addin.wordCalls()).searches).toBe(0);

  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await addin.wordDocument()).bookmarks.length)
    .toBe(0);

  const afterAccept = await addin.wordDocument();
  expect(afterAccept.settings[ANCHOR_SETTINGS_KEY]).toBeUndefined();
  const calls = await addin.wordCalls();
  expect(calls.deletedBookmarks).toEqual([bookmark.name]);
  expect(calls.acceptedChanges).toEqual([
    { text: REPLACEMENT, location: "After", original: ORIGINAL },
  ]);
});

test("restores from the deterministic bookmark name when the settings registry is missing", async ({
  addin,
  page,
}) => {
  await mockPersistedChat(addin);
  const bookmark = await applyPersistedEdit(addin, page);

  await addin.removeWordDocumentSetting(ANCHOR_SETTINGS_KEY);
  const withoutRegistry = await addin.wordDocument();
  expect(withoutRegistry.settings[ANCHOR_SETTINGS_KEY]).toBeUndefined();
  expect(withoutRegistry.bookmarks.map(({ name }) => name)).toEqual([
    bookmark.name,
  ]);

  await reloadAndOpenPersistedChat(addin, page);

  const view = page.getByRole("button", { name: "View", exact: true });
  await expect(view).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toBeVisible();
  const callsAfterRestore = await addin.wordCalls();
  expect(callsAfterRestore.bookmarkLookups).toEqual([bookmark.name]);
  expect(callsAfterRestore.searches).toBe(0);

  await view.click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges.length)
    .toBe(1);
  expect((await addin.wordCalls()).searches).toBe(0);
});

test("ignores a corrupt registry entry instead of touching an unrelated bookmark", async ({
  addin,
  page,
}) => {
  await mockPersistedChat(addin);
  const bookmark = await applyPersistedEdit(addin, page);
  await addin.setWordDocumentSetting(ANCHOR_SETTINGS_KEY, {
    version: 1,
    anchors: {
      [STABLE_EDIT_ID]: {
        bookmarkName: "UnrelatedUserBookmark",
        createdAt: "2026-08-09T00:00:00Z",
      },
    },
  });

  await reloadAndOpenPersistedChat(addin, page);

  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  const calls = await addin.wordCalls();
  expect(calls.bookmarkLookups).toEqual([bookmark.name]);
  expect(calls.deletedBookmarks).not.toContain("UnrelatedUserBookmark");
  expect((await addin.wordDocument()).settings[ANCHOR_SETTINGS_KEY]).toEqual({
    version: 1,
    anchors: {
      [STABLE_EDIT_ID]: {
        bookmarkName: bookmark.name,
        createdAt: expect.any(String),
      },
    },
  });
});

test("prunes a stale bookmark after its revisions were resolved directly in Word", async ({
  addin,
  page,
}) => {
  await mockPersistedChat(addin);
  const bookmark = await applyPersistedEdit(addin, page);

  expect(await addin.resolveBookmarkExternally(bookmark.name, "accepted")).toBe(
    true,
  );
  expect((await addin.wordDocument()).bookmarks[0]?.pendingRevisionCount).toBe(
    0,
  );

  await reloadAndOpenPersistedChat(addin, page);
  await expect
    .poll(async () => (await addin.wordDocument()).bookmarks.length)
    .toBe(0);

  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  const afterRestore = await addin.wordDocument();
  expect(afterRestore.settings[ANCHOR_SETTINGS_KEY]).toBeUndefined();
  const calls = await addin.wordCalls();
  expect(calls.deletedBookmarks).toEqual([bookmark.name]);
  expect(calls.searches).toBe(0);
});

test("keeps review controls when the bookmark holds an unrelated sibling revision", async ({
  addin,
  page,
}) => {
  await mockPersistedChat(addin);
  const bookmark = await applyPersistedEdit(addin, page);

  expect(
    await addin.injectRevisionIntoBookmark(
      bookmark.name,
      "Added",
      "Unrelated user revision",
    ),
  ).toBe(true);
  expect((await addin.wordDocument()).bookmarks[0]?.pendingRevisionCount).toBe(
    3,
  );

  await reloadAndOpenPersistedChat(addin, page);

  // Word ranges report sibling revisions from the same passage; Mike's own
  // Added/Deleted pair is still unambiguous, so the card stays actionable.
  const view = page.getByRole("button", { name: "View", exact: true });
  await expect(view).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toBeVisible();

  // Accepting resolves exactly Mike's pair — never the injected revision.
  await accept.click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  const calls = await addin.wordCalls();
  expect(calls.acceptedChanges).toEqual([
    { text: REPLACEMENT, location: "After", original: ORIGINAL },
  ]);
  expect(calls.rejectedChanges).toEqual([]);
  expect(calls.searches).toBe(0);
});

test("stays View-only when the bookmark's revisions no longer identify the edit", async ({
  addin,
  page,
}) => {
  await mockPersistedChat(addin);
  const bookmark = await applyPersistedEdit(addin, page);

  // A second identical Added revision makes Mike's insertion ambiguous, so
  // no revision may be resolved on the user's behalf.
  expect(
    await addin.injectRevisionIntoBookmark(bookmark.name, "Added", REPLACEMENT),
  ).toBe(true);

  await reloadAndOpenPersistedChat(addin, page);

  const view = page.getByRole("button", { name: "View", exact: true });
  await expect(view).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  await view.click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges.length)
    .toBe(1);
  expect((await addin.wordCalls()).searches).toBe(0);
  expect((await addin.wordDocument()).bookmarks).toHaveLength(1);
});

test("View never deletes the bookmark of an edit resolved outside Mike", async ({
  addin,
  page,
}) => {
  await mockPersistedChat(addin);
  const bookmark = await applyPersistedEdit(addin, page);

  // A user revision inside the passage keeps the card View-only, which is the
  // one path that reveals through the bookmark instead of a retained proxy.
  expect(
    await addin.injectRevisionIntoBookmark(
      bookmark.name,
      "Added",
      "Unrelated user revision",
    ),
  ).toBe(true);
  await reloadAndOpenPersistedChat(addin, page);

  const view = page.getByRole("button", { name: "View", exact: true });
  await expect(view).toBeVisible();

  // Accepting everything from Word's own Review tab empties the bookmark.
  expect(await addin.resolveBookmarkExternally(bookmark.name, "accepted")).toBe(
    true,
  );
  await view.click();

  // The card correctly reports that nothing is pending — but View only reads,
  // so the anchor survives for the next reload to prune.
  await expect(
    page.getByText("Word no longer reports a pending revision for this change."),
  ).toBeVisible();
  expect((await addin.wordDocument()).bookmarks.map(({ name }) => name)).toEqual(
    [bookmark.name],
  );
  expect((await addin.wordCalls()).deletedBookmarks).toEqual([]);
});

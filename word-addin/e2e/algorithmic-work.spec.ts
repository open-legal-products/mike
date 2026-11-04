import { test, expect } from "./support/fixtures";
import { formatEdit, replacementEdit, wordEdits } from "./support/editProtocol";

// A persisted assistant message: applied edits get durable anchors.
const PERSISTED = { chatId: "chat-algorithmic-work", assistantMessageId: "assistant-algorithmic-work" };

test("bulk acceptance resolves twenty edits through their own revisions in one batch", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  const originals = Array.from({ length: 20 }, (_, i) => `Original clause ${String(i).padStart(2, "0")}`);
  await addin.mockChatStream([wordEdits(...originals.map((original, i) => replacementEdit(original, `Revised clause ${i}`, "Clarify wording.")))], PERSISTED);
  await addin.gotoTaskpane({ documentText: originals.join(".\n") });
  await addin.expectAuthedShell();
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
  await page.getByPlaceholder("How can I help?").fill("Clarify every clause");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(20);
  await expect.poll(async () => (await addin.wordDocument()).bookmarks.length).toBe(20);
  const before = await addin.wordCalls();
  await page.getByRole("button", { name: "Accept all", exact: true }).click();
  await expect.poll(async () => (await addin.wordCalls()).acceptedChanges.length).toBe(20);
  await expect(page.getByText("Accepted.", { exact: true })).toHaveCount(20);
  const after = await addin.wordCalls();
  // Each edit's retained revisions are its own: no document-wide inventory
  // (a text match there could be someone else's revision).
  expect(after.bodyRevisionReads - before.bodyRevisionReads).toBe(0);
  expect(after.rejectedChanges).toEqual([]);
  // Per apply batch (request context; streaming makes 2-5 of them here):
  // exactly one decision run and one cleanup run (bookmarks + proxies), and
  // one registry save. Inside the decision run: one read-back sync, then one
  // sync per edit, so a failed sync leaves no doubt about the edits before
  // it. Per-edit resolution would cost at least two runs per edit (40+), so
  // the absolute ceiling also catches a silent fallback to it.
  const runs = after.runs - before.runs;
  expect(runs).toBe(2 * after.trackAllContexts);
  expect(runs).toBeLessThan(20);
  expect(after.syncs - before.syncs).toBe(20 + 2 * after.trackAllContexts);
  expect(after.settingsSaves - before.settingsSaves).toBe(1);
  expect(after.deletedBookmarks.length - before.deletedBookmarks.length).toBe(20);
});

test("bulk acceptance of format edits saves the anchor registry once", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  const phrases = Array.from({ length: 8 }, (_, i) => `Defined term ${i}`);
  await addin.mockChatStream([wordEdits(...phrases.map((phrase) => formatEdit(phrase, ["bold"], "Emphasize.")))], PERSISTED);
  await addin.gotoTaskpane({ documentText: phrases.join(".\n") });
  await addin.expectAuthedShell();
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
  await page.getByPlaceholder("How can I help?").fill("Bold every term");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(8);
  await expect.poll(async () => (await addin.wordDocument()).bookmarks.length).toBe(8);
  const before = await addin.wordCalls();
  await page.getByRole("button", { name: "Accept all", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toHaveCount(8);
  const after = await addin.wordCalls();
  expect(after.acceptedChanges).toHaveLength(8);
  // Format edits resolve one by one (their own children batch each), but the
  // cleanup is one batch and one save for the whole decision.
  expect(after.settingsSaves - before.settingsSaves).toBe(1);
  expect(after.runs - before.runs).toBeLessThanOrEqual(8 + after.trackAllContexts);
});

test("switching chats releases every applied edit in one Word batch", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  const originals = Array.from({ length: 12 }, (_, i) => `Clause ${String(i).padStart(2, "0")} text`);
  await addin.mockChatStream([wordEdits(...originals.map((original, i) => replacementEdit(original, `Clause ${i} revised`, "Clarify.")))], PERSISTED);
  await addin.gotoTaskpane({ documentText: originals.join(".\n") });
  await addin.expectAuthedShell();
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
  await page.getByPlaceholder("How can I help?").fill("Clarify every clause");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(12);
  const before = (await addin.wordCalls()).runs;
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  // At most one untrack batch per apply batch, not one per edit.
  const { trackAllContexts } = await addin.wordCalls();
  await expect.poll(async () => (await addin.wordCalls()).runs - before).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect((await addin.wordCalls()).runs - before).toBeLessThanOrEqual(trackAllContexts);
  // Nothing in the document was decided by leaving the chat.
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);
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

test("Accept all shows every outcome without waiting for each record to save", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  const originals = Array.from({ length: 5 }, (_, i) => `Party name ${i}`);
  await addin.mockChatStream([wordEdits(...originals.map((original, i) => replacementEdit(original, `Party ${i}`, "Shorten.")))], PERSISTED);
  // Hold every edit record on the server until the test releases it.
  const saved: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/word-chat/messages/*/edits/*?*", async (route, request) => {
    if (request.method() !== "PATCH") return route.fallback();
    if ((request.postDataJSON() as { resolution_status?: string }).resolution_status === "accepted") {
      saved.push(new URL(request.url()).pathname.split("/").pop()!);
    }
    await held;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await addin.gotoTaskpane({ documentText: originals.join(".\n") });
  await addin.expectAuthedShell();
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
  await page.getByPlaceholder("How can I help?").fill("Shorten the party names");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(5);
  await page.getByRole("button", { name: "Accept all", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toHaveCount(5);
  release();
  // Records still save one at a time, in card order.
  await expect.poll(() => saved).toEqual(["0", "1", "2", "3", "4"]);
});

test("reopening a chat validates its proposed edits in one Word batch", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  const originals = Array.from({ length: 10 }, (_, i) => `Notice period ${i}`);
  const chat = { id: "chat-proposed", project_id: null, user_id: "user-1", title: "Proposed review", created_at: "2026-08-19T00:00:00Z" };
  await addin.mockApiJson("GET", "**/word-chat?*", [chat]);
  await addin.mockApiJson("GET", `**/word-chat/${chat.id}?*`, {
    chat,
    messages: [{
      id: "assistant-proposed", chat_id: chat.id, role: "assistant", created_at: "2026-08-19T00:00:01Z",
      content: originals.map((_, i) => ({ type: "word_edit_ref", edit_id: `proposed-${i}` })),
      edits: originals.map((original, i) => ({
        id: `proposed-${i}`, word_chat_message_id: "assistant-proposed", block_index: i, original_text: original,
        replacement_text: `${original} days`, formats: [], apply_mode: "approval", apply_status: "proposed", resolution_status: null,
      })),
    }],
  });
  // The last proposal's text is no longer in the document.
  await addin.gotoTaskpane({ documentText: originals.slice(0, -1).join(".\n") });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Chat history" }).click();
  const before = await addin.wordCalls();
  await page.getByRole("menu").getByRole("menuitem", { name: /Proposed review/ }).click();
  await expect(page.getByRole("button", { name: "Apply", exact: true })).toHaveCount(9);
  await expect(page.locator('[data-edit-status="validating"]')).toHaveCount(0);
  const after = await addin.wordCalls();
  // One batch probes the document for already-applied rows; one validates all
  // ten: every search in one sync, every revision check in the next. The
  // not-found verdict hides Apply and is persisted, so it is confirmed on its
  // own first: one more run, one more search.
  // A bound with headroom (one run per proposal would be 12); the exact
  // confirmation behaviour is pinned by the search count below.
  expect(after.runs - before.runs).toBeLessThanOrEqual(4);
  expect(after.searches - before.searches).toBe(11);
});

test("applying one tracked edit costs at most eight host round trips", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  await addin.mockChatStream([wordEdits(replacementEdit("Suplier", "Supplier", "Fix the party name."))], PERSISTED);
  await addin.gotoTaskpane({ documentText: "The Suplier shall deliver the goods." });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();
  const apply = page.getByRole("button", { name: "Apply", exact: true });
  await expect(apply).toBeEnabled();
  const before = await addin.wordCalls();
  await apply.click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  const after = await addin.wordCalls();
  expect(after.insertedBookmarks).toHaveLength(1);
  // Read mode, TrackAll, search, revision check + paragraph, mutation (with
  // the generated revisions' type and text), tracking, bookmark (its own
  // sync: a refused bookmark must stay a warning), restore mode. A bound, not
  // an exact count: it fails if the paragraph or revision-field loads regain
  // their own round trips (9).
  expect(after.syncs - before.syncs).toBeLessThanOrEqual(8);
});

test("a bookmark Word refuses at sync stays a warning", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  await addin.mockChatStream([wordEdits(replacementEdit("Suplier", "Supplier", "Fix the party name."))], PERSISTED);
  await addin.gotoTaskpane({ documentText: "The Suplier shall deliver the goods.", bookmarkSyncFailures: 1 });
  await addin.expectAuthedShell();
  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  // Still applied and reviewable; only the durable View link is missing.
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  await expect(page.getByText(/View link may not survive/)).toBeVisible();
  expect((await addin.wordDocument()).bookmarks).toEqual([]);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
});

test("Word for Mac restores many edits with one adjacency round trip", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  const originals = Array.from({ length: 6 }, (_, i) => `Payment term ${i}`);
  const chat = { id: PERSISTED.chatId, project_id: null, user_id: "user-1", title: "Mac restore", created_at: "2026-08-19T00:00:00Z" };
  await addin.mockChatStream([wordEdits(...originals.map((original, i) => replacementEdit(original, `Term ${i}`, "Shorten.")))], PERSISTED);
  await addin.mockApiJson("GET", "**/word-chat?*", [chat]);
  await addin.mockApiJson("GET", `**/word-chat/${chat.id}?*`, {
    chat,
    messages: [{
      id: PERSISTED.assistantMessageId, chat_id: chat.id, role: "assistant", created_at: "2026-08-19T00:00:01Z",
      content: originals.map((_, i) => ({ type: "word_edit_ref", edit_id: `mac-${i}` })),
      edits: originals.map((original, i) => ({
        id: `mac-${i}`, word_chat_message_id: PERSISTED.assistantMessageId, block_index: i, original_text: original,
        replacement_text: `Term ${i}`, formats: [], apply_mode: "direct", apply_status: "applied", resolution_status: null,
        matched_occurrences: 1, applied_occurrences: 1,
      })),
    }],
  });
  await addin.gotoTaskpane({ documentText: originals.join(".\n"), macDesktopRevisions: true });
  await addin.expectAuthedShell();
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
  await page.getByPlaceholder("How can I help?").fill("Shorten the terms");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(async () => (await addin.wordDocument()).bookmarks.length).toBe(6);

  await addin.reloadTaskpane();
  await page.getByRole("button", { name: "Chat history" }).click();
  const before = (await addin.wordCalls()).syncs;
  await page.getByRole("menu").getByRole("menuitem", { name: /Mac restore/ }).click();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(6);
  // Bookmark lookup, their revisions with type and text, the document
  // revision inventory with range text, the adjacency probes for every edit
  // at once, and tracking.
  // Bounded, not exact: one sync per restored edit (10), or per-item
  // revision field loads (7), would exceed it.
  expect((await addin.wordCalls()).syncs - before).toBeLessThanOrEqual(6);
  await page.getByRole("button", { name: "Accept", exact: true }).first().click();
  await expect(page.getByText("Accepted.", { exact: true })).toHaveCount(1);
  expect((await addin.wordCalls()).acceptedChanges).toHaveLength(1);
});

test("a card decision re-renders only the assistant message that owns it", async ({ addin, page }) => {
  addin.seedToken("test-jwt");
  // Count, per assistant message id, the commits in which React gave
  // AssistantMessage new props. React reports every commit to a DevTools
  // hook (production builds too); an unchanged memoizedProps object means
  // React.memo skipped that message.
  await page.addInitScript(() => {
    type Fiber = { tag: number; child: Fiber | null; sibling: Fiber | null; memoizedProps?: { message?: { id?: string }; editStateByKey?: unknown } };
    const renders: Record<string, number> = {};
    const lastProps = new Map<string, unknown>();
    (window as unknown as { __MESSAGE_RENDERS__: Record<string, number> }).__MESSAGE_RENDERS__ = renders;
    const visit = (start: Fiber | null): void => {
      for (let fiber = start; fiber; fiber = fiber.sibling) {
        const props = fiber.memoizedProps;
        if ((fiber.tag === 14 || fiber.tag === 15) && props?.message?.id && props.editStateByKey) {
          if (lastProps.get(props.message.id) !== props) {
            if (lastProps.has(props.message.id)) renders[props.message.id] = (renders[props.message.id] ?? 0) + 1;
            lastProps.set(props.message.id, props);
          }
        }
        visit(fiber.child);
      }
    };
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => visit(root.current.child),
    };
  });
  const originals = Array.from({ length: 5 }, (_, i) => `Clause ${i} wording`);
  await addin.gotoTaskpane({ documentText: originals.join(".\n") });
  await addin.expectAuthedShell();
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: /Edit/ }).click();
  for (const [i, original] of originals.entries()) {
    await addin.mockChatStream([`Turn ${i}. ` + wordEdits(replacementEdit(original, `Clause ${i} text`, "Tighten."))]);
    await page.getByPlaceholder("How can I help?").fill(`Tighten clause ${i}`);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(i + 1);
  }
  await page.evaluate(() => {
    const renders = (window as unknown as { __MESSAGE_RENDERS__: Record<string, number> }).__MESSAGE_RENDERS__;
    for (const key of Object.keys(renders)) delete renders[key];
  });
  // dispatchEvent: in WebKit Playwright never sees this mid-transcript
  // button as "stable" (layout keeps settling), though it is clickable.
  await page.getByRole("button", { name: "Accept", exact: true }).nth(2).dispatchEvent("click");
  await expect(page.getByText("Accepted.", { exact: true })).toHaveCount(1);
  const renders = await page.evaluate(() => (window as unknown as { __MESSAGE_RENDERS__: Record<string, number> }).__MESSAGE_RENDERS__);
  // Busy, then accepted: one message, never the other four.
  expect(Object.keys(renders)).toHaveLength(1);
});

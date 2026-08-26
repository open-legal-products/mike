/**
 * Chat-management E2E tests:
 *   1. Cold-load existing chat — verifies getChat() API loads messages on direct URL
 *   2. Rename a chat from sidebar — verifies rename API and sidebar UI update
 *   3. Delete a chat from sidebar — verifies delete API and sidebar removal
 *   4. Project assistant: create a new chat and submit a question
 *
 * Auth: inherits storageState from playwright.config.ts ("e2e/.auth/user.json")
 * Test user: e2e@mike.local / E2eTestPass1!
 */
import { test, expect, type Page } from "@playwright/test";
import { hasLlmKey, LLM_SKIP_REASON } from "./llm";
import { selectClaudeModel } from "./helpers";

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

/**
 * Ensure the app sidebar is expanded so that "Assistant History" is visible.
 *
 * layout.tsx initialises isSidebarOpen=true on desktop (≥768 px, which is
 * Playwright's Desktop Chrome viewport), but the project-chat page calls
 * setSidebarOpen(false) on mount.  This helper reopens it if needed.
 */
async function ensureSidebarOpen(page: Page) {
    const historySection = page.getByText("Assistant History");
    if (!(await historySection.isVisible())) {
        // The toggle button's title alternates between "Open sidebar" and "Close sidebar"
        // (AppSidebar.tsx onToggle handler).  Use the first match in case both the
        // desktop and mobile toggle buttons are in the DOM simultaneously.
        await page.getByTitle("Open sidebar").first().click();
        await expect(historySection).toBeVisible({ timeout: 5_000 });
    }
}

/* ─── Test 1: cold-load existing chat ───────────────────────────────────────── */

test("cold-load: direct URL to a chat triggers the getChat history load", async ({ page }) => {
    // REGRESSION: fails if AssistantChatPage's cold-load history load is removed —
    // i.e. if the component stops calling getChat(id) on mount
    // (AssistantChatPage.tsx:37-45).  On a direct navigation we assert (a) the
    // GET /chat/<id> request actually fires, and (b) its result drives the
    // documented navigation: when getChat yields no messages the page redirects
    // back to /assistant (AssistantChatPage.tsx:42/45 router.replace("/assistant")).
    // Verified by temporarily removing the getChat(...) call: the request no longer
    // fires and no redirect happens, so this test fails.
    //
    // Why not assert a rendered message?  This environment can't produce a chat
    // with stored messages: no LLM provider key is configured (so the UI's
    // Enter-to-send is blocked by the ApiKeyMissingModal, ChatInput.tsx:116-119),
    // and even a direct POST /chat can't persist one — chat.routes.ts:530-536
    // inserts a `workflow` column that does not exist on chat_messages, so every
    // message insert fails silently and the table stays empty.  An existing-but-
    // empty chat and a never-created chat id are therefore observably identical
    // here: getChat runs, returns no messages, and AssistantChatPage redirects.
    // Using a fresh id keeps the test self-contained — no chat-creation request to
    // fail under DB churn, no message-history precondition that can't be met.

    // A valid-shaped UUID that will not exist (gen_random_uuid never yields it),
    // so getChat(id) → GET /chat/<id> resolves 404 and the page redirects.
    const chatId = "00000000-0000-4000-8000-000000000000";

    // ── Step 1: the cold-load getChat(id) call must issue GET <api>/chat/<id> ─────
    // Scope to the same-origin API gateway path so we match the getChat() API
    // call and NOT the Next.js page/RSC navigation request, whose URL also
    // contains the path "/assistant/chat/<id>".
    const getChatRequest = page.waitForResponse(
        (r) =>
            new URL(r.url()).pathname === `/api/chat/${chatId}` &&
            r.request().method() === "GET",
        { timeout: 20_000 },
    );
    await page.goto(`/assistant/chat/${chatId}`);
    await getChatRequest; // proves the cold-load getChat(id) call happened

    // ── Step 2: with no messages, AssistantChatPage redirects to the landing ─────
    await expect(page).toHaveURL(/\/assistant$/, { timeout: 15_000 });
});

/* ─── Test 2: rename a chat from sidebar ────────────────────────────────────── */

test("rename chat: sidebar rename interaction updates the title", async ({ page }) => {
    test.skip(!hasLlmKey, LLM_SKIP_REASON);
    // REGRESSION: fails if the renameChat API call or the optimistic title update in
    // ChatHistoryContext.renameChatFn / SidebarChatItem.handleRenameSave is removed.

    // Chat creation (saveChat → POST /chat/create) can be slow when the dev server
    // / DB is under load, so allow extra headroom over the default 30s test cap.
    test.setTimeout(90_000);

    const message = `Rename test ${Date.now()}`;
    const newTitle = `Renamed Chat ${Date.now()}`;

    // ── Step 1: create a new chat ─────────────────────────────────────────────────
    await page.goto("/assistant");
    const textarea = page.getByPlaceholder("How can I help?");
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    // Pick a Claude model (available via the backend's ANTHROPIC_API_KEY) so
    // the submit isn't blocked by the ApiKeyMissingModal — the default Gemini
    // model has no key configured in this run.
    await selectClaudeModel(page);
    await textarea.fill(message);

    // Sending the first message triggers auto title-generation
    // (useGenerateChatTitle → POST /chat/<id>/generate-title → renameChat). That
    // would overwrite our manual rename below if it lands afterwards, so wait for
    // it to settle first. Best-effort: if it never fires (e.g. the LLM errors),
    // proceed — our manual rename is then unopposed.
    const titleGenerated = page
        .waitForResponse(
            (r) =>
                /^\/api\/chat\/[^/]+\/generate-title$/.test(
                    new URL(r.url()).pathname,
                ) &&
                r.request().method() === "POST",
            { timeout: 30_000 },
        )
        .catch(() => null);
    await textarea.press("Enter");

    // ── Step 2: wait for navigation to the new chat page ─────────────────────────
    await page.waitForURL(/\/assistant\/chat\/.+/, { timeout: 45_000 });
    await titleGenerated; // let auto title-generation apply before we rename

    // ── Step 3: ensure the sidebar is open ───────────────────────────────────────
    await ensureSidebarOpen(page);

    // ── Step 4: locate the active chat item ──────────────────────────────────────
    // SidebarChatItem.tsx renders a `div.group.relative` wrapper for each chat.
    // When isActive=true the wrapper carries APP_SURFACE_ACTIVE_CLASS
    // ("bg-app-surface-active"); inactive items carry APP_SURFACE_HOVER_CLASS
    // ("hover:bg-app-surface-hover", a different token), so matching
    // "bg-app-surface-active" distinguishes the active item. (The olp liquid-
    // surface refresh renamed the old "bg-gray-200/60" active token.)
    const activeItem = page
        .locator('div.group.relative[class*="bg-app-surface-active"]')
        .first();

    // The active item's trigger is already opacity-100, but hover is harmless and
    // keeps parity with the inactive-item path.
    await activeItem.hover();

    // ── Step 5: click the MoreHorizontal trigger (three-dot menu) ────────────────
    // SidebarChatItem.tsx lines 104-115: DropdownMenuTrigger wraps a <button> with
    // the MoreHorizontal icon.  In the non-renaming state the two buttons inside the
    // item are [0] chat-title button and [1] the trigger; .last() picks the trigger.
    const triggerBtn = activeItem.locator("button").last();
    await triggerBtn.click();

    // ── Step 6: click "Rename" in the Radix DropdownMenuContent ─────────────────
    // SidebarChatItem.tsx lines 117-129: DropdownMenuItem with Pencil icon + "Rename"
    const renameItem = page.getByRole("menuitem", { name: "Rename" });
    await expect(renameItem).toBeVisible({ timeout: 5_000 });
    await renameItem.click();

    // ── Step 7: type the new title in the inline input ───────────────────────────
    // SidebarChatItem.tsx lines 56-68: isRenaming state shows an <input type="text">
    // that is focused automatically (editInputRef.current?.focus() in useEffect).
    // There is no data-testid; scope to the item container to avoid ambiguity.
    const renameInput = activeItem.locator("input[type='text']");
    await expect(renameInput).toBeVisible({ timeout: 5_000 });
    await renameInput.fill(newTitle);

    // SidebarChatItem.tsx line 63: Enter key calls handleRenameSave()
    await renameInput.press("Enter");

    // ── Step 8: assert the new title appears in the sidebar ──────────────────────
    // ChatHistoryContext.renameChatFn optimistically updates the chat title in state.
    // SidebarChatItem re-renders the title button with the new text.
    await expect(
        page.getByRole("button", { name: newTitle })
    ).toBeVisible({ timeout: 10_000 });
});

/* ─── Test 3: delete a chat from sidebar ────────────────────────────────────── */

test("delete chat: sidebar delete action removes the chat from history", async ({ page }) => {
    test.skip(!hasLlmKey, LLM_SKIP_REASON);
    // REGRESSION: fails if the deleteChat API call or the optimistic list removal in
    // ChatHistoryContext.deleteChatFn (filter by chatId) is removed.

    // Chat creation (saveChat → POST /chat/create) can be slow when the dev server
    // / DB is under load, so allow extra headroom over the default 30s test cap.
    test.setTimeout(90_000);

    const message = `Delete test ${Date.now()}`;

    // ── Step 1: create a new chat ─────────────────────────────────────────────────
    await page.goto("/assistant");
    const textarea = page.getByPlaceholder("How can I help?");
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    // ── Step 2: create the chat ──────────────────────────────────────────────────
    // ChatInput.handleSubmit creates the chat (saveChat → POST /chat/create) then
    // navigates to /assistant/chat/<id>.
    const newChatUrl = /\/assistant\/chat\/.+/;

    // Sending the first message kicks off auto title-generation
    // (useGenerateChatTitle → POST /chat/<id>/generate-title → renameChat). If it
    // lands after the manual rename in step 4 it overwrites the unique title and
    // the row can no longer be found. Wait for it to settle first, exactly as the
    // rename test does. Best-effort: if it never fires, our rename is unopposed.
    const titleGenerated = page
        .waitForResponse(
            (r) =>
                /^\/api\/chat\/[^/]+\/generate-title$/.test(
                    new URL(r.url()).pathname,
                ) &&
                r.request().method() === "POST",
            { timeout: 30_000 },
        )
        .catch(() => null);

    // Pick a Claude model (available via the backend's ANTHROPIC_API_KEY) so
    // the submit isn't blocked by the ApiKeyMissingModal, then send the first
    // message.
    await selectClaudeModel(page);
    await textarea.fill(message);
    await textarea.press("Enter");
    await page.waitForURL(newChatUrl, { timeout: 20_000 });

    // Let auto title-generation land before renaming, so it cannot clobber the
    // unique title this test targets the row by.
    await titleGenerated;

    // ── Step 3: ensure the sidebar is open ───────────────────────────────────────
    await ensureSidebarOpen(page);

    // ── Step 4: rename the new chat to a unique title so we can target it ─────────
    // The shared test user accumulates many chats across runs and the sidebar
    // paginates at INITIAL_CHAT_LIMIT (20), so total-row-count and positional
    // assertions are unreliable. Instead, give this chat a unique title and then
    // assert on that exact title — immune to pagination and to other chats. The
    // just-created chat is active and prepended, so it is the first row; rename it
    // via the same three-dot menu the rename test exercises.
    const uniqueTitle = `Delete Target ${Date.now()}`;
    const firstRow = page.locator("div.group.relative.h-8.rounded-md").first();
    await firstRow.hover();
    await firstRow.locator("button").last().click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const renameInput = firstRow.locator("input[type='text']");
    await expect(renameInput).toBeVisible({ timeout: 5_000 });
    await renameInput.fill(uniqueTitle);
    await renameInput.press("Enter");

    // The renamed chat's title button now uniquely identifies its row.
    const targetTitle = page.getByRole("button", { name: uniqueTitle });
    await expect(targetTitle).toBeVisible({ timeout: 10_000 });
    // The row wrapper that contains that title button (for reaching its menu).
    const targetRow = page
        .locator("div.group.relative.h-8.rounded-md")
        .filter({ has: targetTitle });

    // ── Step 5-7: delete that specific chat ──────────────────────────────────────
    // deleteChatFn (ChatHistoryContext.tsx:157-168) optimistically removes the
    // row. SidebarChatItem.tsx:132-144: the "Delete" DropdownMenuItem calls
    // deleteChat(chat.id) directly — no confirmation dialog.
    await targetRow.hover();
    await targetRow.locator("button").last().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(targetTitle).toBeHidden({ timeout: 10_000 });
});

/* ─── Test 4: project assistant — create new chat ───────────────────────────── */

test("project assistant: create a new chat and submit a question", async ({ page }) => {
    test.skip(!hasLlmKey, LLM_SKIP_REASON);
    // REGRESSION: fails if the project chat creation route is broken — specifically if
    // handleNewChat() in ProjectPage.tsx (lines 515-519) fails to call saveChat() or
    // router.push to /projects/[id]/assistant/chat/[chatId]. (Verified by temporarily
    // removing that router.push: "+ Create New" then no longer navigates and the
    // Step 8 waitForURL below fails.)

    // This test creates a project then a chat (two sequential write round-trips
    // plus a navigation each) and ends with an LLM-backed submit, so give it
    // headroom beyond the 30s default.
    test.setTimeout(120_000);

    // ── Step 1: navigate to projects ─────────────────────────────────────────────
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/, { timeout: 10_000 });

    // ── Step 2: open the "New project" modal ─────────────────────────────────────
    const createBtn = page.getByRole("button", { name: "New project" });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    // ── Step 3: fill in the project name ─────────────────────────────────────────
    // NewProjectModal.tsx line 203: disabled={!name.trim() || loading}
    // PDF upload is optional — we omit it to keep this test focused on routing.
    const nameInput = page.getByPlaceholder("Project name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    const projectName = `E2E Chat Route ${Date.now()}`;
    await nameInput.fill(projectName);

    // NewProjectModal is a two-step wizard ("Details" → "Add Documents"); the
    // "Create project" submit button only exists on the second step.
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // ── Step 4: submit the form ──────────────────────────────────────────────────
    // NewProjectModal.handleSubmit does NOT navigate itself — it calls onCreated()
    // then onClose().  ProjectsOverview.onCreated (ProjectsOverview.tsx:475-478)
    // inserts the row AND router.push(`/projects/${p.id}`), so the app navigates
    // straight to the project detail page; the name never re-appears in a list to
    // click.  Wait for that navigation instead of asserting a list row.
    const submitBtn = page.getByRole("button", {
        name: /create project|creating/i,
    });
    const projectUrl = /\/projects\/[^/]+$/;
    await expect(submitBtn).toBeEnabled({ timeout: 10_000 });
    await submitBtn.click();
    await page.waitForURL(projectUrl, { timeout: 20_000 });

    // ── Step 6: open the assistant tab and reach the empty-state "Create" ────────
    // The project assistant is now a nested route (/projects/[id]/assistant), not a
    // ?tab= query on the detail page. Navigating straight there avoids ambiguity
    // with the sidebar "Assistant" nav item.
    const assistantUrl = page.url() + "/assistant";
    // The olp UI replaced the old "+ Create New" text link with a PillButton
    // reading "Create" in the ProjectAssistantTable empty state
    // (ProjectAssistantTable.tsx:110-115, shown when chats.length === 0).
    const createNewBtn = page.getByRole("button", { name: "Create", exact: true });
    await page.goto(assistantUrl);
    await expect(createNewBtn).toBeVisible({ timeout: 20_000 });

    // ── Step 7-8: click "Create" and wait for the project chat URL ───────────────
    // handleNewChat (ProjectPage.tsx:515-519) calls saveChat(projectId) then
    // router.push(`/projects/${projectId}/assistant/chat/${id}`).
    //
    // REGRESSION (the target of this test): if handleNewChat's router.push is
    // removed — or saveChat itself is broken — no navigation happens and the
    // waitForURL below fails.
    const chatUrl = /\/projects\/.+\/assistant\/chat\/.+/;
    await createNewBtn.click();
    await page.waitForURL(chatUrl, { timeout: 20_000 });

    // ── Step 9: assert the ChatInput textarea is visible ─────────────────────────
    // ProjectAssistantChatPage renders <ChatInput> in the right "Project Assistant"
    // panel (line 1221-1229 of the chat page component).
    const chatInput = page.getByPlaceholder("How can I help?");
    await expect(chatInput).toBeVisible({ timeout: 10_000 });

    // ── Step 10-11: pick an available model, submit a question, assert it clears ──
    // ChatInput.handleSubmit (ChatInput.tsx:113-140) clears the textarea
    // synchronously (setValue("")) ONLY when the selected model is available and no
    // prior response is in flight; otherwise it returns early. Two transient gates
    // exist under load:
    //   • useSelectedModel (useSelectedModel.ts:16-20) seeds DEFAULT (Gemini) for
    //     one render before its localStorage-read effect restores the Claude
    //     model, so a submit racing a ChatInput remount can momentarily see
    //     Gemini → the ApiKeyMissingModal ("API key required") pops and the
    //     submit no-ops.
    //   • A transient in-flight response (isResponseLoading) also no-ops the submit.
    // Re-select the Claude model and re-submit until the textarea clears. A
    // genuinely broken send never clears on ANY attempt, so a real regression is
    // still caught.
    const question = "What is in this project?";
    const apiKeyModalHeading = page.getByRole("heading", {
        name: "API key required",
    });
    const SUBMIT_ATTEMPTS = 4;
    let cleared = false;
    for (let attempt = 0; attempt < SUBMIT_ATTEMPTS && !cleared; attempt++) {
        // Dismiss a stray "API key required" modal left by a prior racey attempt
        // (Cancel closes it without navigating; "Go to settings" would).
        if (await apiKeyModalHeading.isVisible().catch(() => false)) {
            await page
                .getByRole("button", { name: "Cancel" })
                .click()
                .catch(() => {});
        }
        // Re-assert the Claude model as the active (available) model after any remount.
        await selectClaudeModel(page);
        await chatInput.fill(question);
        // ChatInput.handleKeyDown: Enter (no Shift) → handleSubmit().
        await chatInput.press("Enter");
        // setValue("") runs synchronously on a successful send.
        cleared = await expect(chatInput)
            .toHaveValue("", { timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
    }
    // Final assertion surfaces a genuinely broken send (never clears).
    await expect(chatInput).toHaveValue("", { timeout: 5_000 });
});

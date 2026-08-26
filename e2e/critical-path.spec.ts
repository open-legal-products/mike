/**
 * Critical path E2E tests:
 *   1. Authenticated landing — /assistant loads correctly
 *   2. Projects — create a project, upload a PDF, open the project assistant,
 *      send a message and verify a response begins streaming
 *
 * Prerequisite: auth.setup.ts has already saved the session to e2e/.auth/user.json
 */
import { test, expect } from "@playwright/test";
import { hasLlmKey, LLM_SKIP_REASON } from "./llm";
import { PDF_FIXTURE, selectClaudeModel } from "./helpers";

/* ─── Test 1: authenticated landing ─────────────────────────────────────── */

test("authenticated user lands on the assistant page", async ({ page }) => {
    await page.goto("/assistant");
    await expect(page).toHaveURL(/\/assistant/);
    /* The InitialView renders a greeting heading */
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
});

/* ─── Test 2: create project → upload PDF → chat ─────────────────────────── */

test("create project, upload PDF, ask a question and receive a response", async ({
    page,
}) => {
    test.skip(!hasLlmKey, LLM_SKIP_REASON);
    /* This end-to-end flow (create + upload + navigate + chat) needs more than
       the 30s default. The per-test `{ timeout }` option that test() accepts is
       silently ignored by Playwright (that object only takes tag/annotation),
       so set it here. */
    test.setTimeout(120_000);

    /* ── Step 1: navigate to projects ─────────────────────────────────────── */
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/);

    /* ── Step 2: open the "New project" modal ────────────────────────────── */
    /* The Plus icon button in the header has aria-label="New project" */
    const createBtn = page.getByRole("button", { name: "New project" });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    /* ── Step 3: fill in the project name ─────────────────────────────────── */
    const nameInput = page.getByPlaceholder("Project name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });

    const projectName = `E2E Test Project ${Date.now()}`;
    await nameInput.fill(projectName);

    /* ── Step 4: advance to "Add Documents" and upload a PDF ──────────────── */
    /* NewProjectModal is a two-step wizard; the details step's primary action is
       a plain "Next" and only the documents step carries the file input. */
    await page.getByRole("button", { name: "Next", exact: true }).click();

    const uploadBtn = page.getByRole("button", { name: /^Upload/ });
    /* We need to trigger the hidden file input; intercept the chooser */
    const fileChooserPromise = page.waitForEvent("filechooser");
    await uploadBtn.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PDF_FIXTURE);

    /* The button label should update to reflect the queued file */
    await expect(
        page.getByRole("button", { name: /^Upload \(1\)/ }),
    ).toBeVisible({ timeout: 5_000 });

    /* ── Step 5: submit the form ──────────────────────────────────────────── */
    /* The PDF upload runs inside NewProjectModal.handleSubmit
       (await Promise.all([uploadProjectDocument(...)])) BEFORE onCreated fires,
       so the "Creating…" button state can persist for many seconds while the
       file uploads. ProjectsOverview.onCreated then router.push()es to the new
       project page, so wait for that navigation (generously, to cover the
       upload). */
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 30_000 });

    /* ── Step 6: open the project assistant ───────────────────────────────── */
    /* We're already on /projects/[id] (Documents tab by default). The project
       assistant is now a nested route, /projects/[id]/assistant. Navigate there
       directly rather than clicking through the tab bar to avoid ambiguity with
       the "Assistant" item in the sidebar nav. (The olp UI replaced the old
       "+ Create New" text link with a PillButton reading "Create" —
       ProjectAssistantTable empty state.) */
    const projectUrl = page.url().split("?")[0];
    const createNew = page.getByRole("button", { name: "Create", exact: true });
    await page.goto(`${projectUrl}/assistant`);

    /* The assistant tab shows a chat list. Click "Create" to open the chat
       interface where the text input appears. */
    await expect(createNew).toBeVisible({ timeout: 20_000 });
    await createNew.click();
    /* Navigates to /projects/{id}/assistant (new chat UI) */
    await page.waitForURL(/\/projects\/.+\/assistant/, { timeout: 10_000 });

    /* ── Step 7: select a Claude model, type a question, submit ───────────── */
    /* Wait on the chat input itself, not on "networkidle". A swallowed
       `waitForLoadState("networkidle", …).catch(() => {})` used to stand here:
       it proved nothing (its failure was discarded) and networkidle is an
       unreliable signal on a page that holds a streaming connection open. The
       input is what the next lines type into, so waiting for it is both the
       real precondition and an honest failure. */
    const chatInput = page.getByPlaceholder("How can I help?");
    await expect(chatInput).toBeVisible({ timeout: 20_000 });

    /* The default Gemini model has no key configured, so submitting it would be
       blocked by the ApiKeyMissingModal. Select a Claude model (backed by the
       ANTHROPIC_API_KEY the backend reads from its environment) so the request
       actually streams a response. */
    await selectClaudeModel(page);
    await chatInput.fill("What is this document about?");
    /* This ChatInput submits on Enter (Shift+Enter inserts a newline). */
    await chatInput.press("Enter");

    /* ── Step 8: verify the assistant streams a response ─────────────────── */
    /* With a real Claude model the reply content is nondeterministic, so assert
       presence + nonempty rather than matching text. The assistant's answer
       renders through MarkdownContent (message/MarkdownContent.tsx), whose
       wrapper div carries "text-gray-900 … prose … font-serif" — a combination
       unique to assistant answer content on this page (user messages render a
       plain <p>, and the gray pre-response EventBlocks prose uses
       text-gray-400). Its appearance with nonempty text proves the message was
       sent, streamed, and rendered end-to-end.

       The reply is preceded by a POST that persists the chat, a client-side
       route change to /assistant/chat/<id>, and a real LLM round-trip; under
       local-Supabase load that can outlast a 30s budget, so allow the same
       headroom the rest of this flow gets. */
    const assistantAnswer = page
        .locator("div.prose.font-serif.text-gray-900")
        .first();
    await expect(assistantAnswer).toBeVisible({ timeout: 60_000 });
    /* Nonempty streamed text (any non-whitespace character). */
    await expect(assistantAnswer).toContainText(/\S/);
});

/* ─── Test 3: login-page redirect for unauthenticated users ──────────────── */

/* describe-scoped test.use so only this test runs without a stored session.
   File-level test.use would wipe the storageState for all tests in this file. */
test.describe("unauthenticated", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("unauthenticated request to /assistant redirects to login", async ({
        page,
    }) => {
        await page.goto("/assistant");
        /* Auth check is client-side (Supabase getSession) — allow time for the
           async check to resolve and for Next.js router.push to fire. */
        await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    });
});

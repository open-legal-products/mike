/**
 * Critical path E2E tests:
 *   1. Authenticated landing — /assistant loads correctly
 *   2. Projects — create a project, upload a PDF, open the project assistant,
 *      read its text through the model tool path and reload the saved answer
 *
 * Auth: runs signed in as this worker's account (the storageState fixture in
 * e2e/fixtures.ts).
 */
import { test, expect } from "./fixtures";
import { hasLlmKey, LLM_SKIP_REASON } from "./llm";
import { createProject, PDF_FIXTURE, selectClaudeModel, expectSavedAnswer } from "./helpers";

/* ─── Test 1: authenticated landing ─────────────────────────────────────── */

test("authenticated user lands on the assistant page", async ({ page }) => {
    await page.goto("/assistant");
    await expect(page).toHaveURL(/\/assistant/);
    /* The InitialView renders a greeting heading */
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
});

/* ─── Test 2: create project → upload PDF → chat ─────────────────────────── */

test("project document: read uploaded PDF and reload the saved answer", async ({ page }) => {
    test.skip(!hasLlmKey, LLM_SKIP_REASON);
    test.setTimeout(120_000);
    await createProject(page, `E2E document ${Date.now()}`, PDF_FIXTURE);
    await page.goto(`${page.url().split("?")[0]}/assistant`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    // Opening the composer must not persist an empty chat; first send creates it.
    await expect(page).toHaveURL(/\/projects\/[^/]+\/assistant\/chat$/);
    await selectClaudeModel(page);
    const input = page.getByPlaceholder("How can I help?");
    await input.fill("Read test.pdf and quote its first line.");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/projects\/[^/]+\/assistant\/chat\/[^/]+$/);
    // This text exists only in the PDF, never in the question. The fixture must
    // request read_document and receive the real extracted text before answering.
    await expectSavedAnswer(page, "Test PDF Document");
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

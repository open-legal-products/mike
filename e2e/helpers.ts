/**
 * Shared E2E helpers.
 *
 * Anything used by more than one spec lives here rather than being copy-pasted:
 * `selectClaudeModel` and `PDF_FIXTURE` had drifted into byte-identical copies
 * across four specs, so a UI change (a renamed model, a moved fixture) meant
 * editing every copy and silently breaking whichever one was missed.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "path";

/** The one-page PDF every upload flow attaches. */
export const PDF_FIXTURE = path.join(__dirname, "fixtures/test.pdf");

/**
 * The model `selectClaudeModel` picks — the cheapest Anthropic entry in
 * ModelToggle.MODELS.
 */
export const CLAUDE_MODEL_LABEL = "Claude Sonnet 4.6";

/**
 * Select a Claude model in the chat input's ModelToggle.
 *
 * The specs that call this run only when ANTHROPIC_API_KEY is set in the
 * Playwright environment (test.skip(!hasLlmKey, ...) — e2e/llm.ts). The CI stack
 * exports the same secret to the backend, whose key resolution (userApiKeys.ts
 * envApiKey()) falls back to the ANTHROPIC_API_KEY env var, so the "claude"
 * provider reports as configured and ModelToggle shows the Anthropic models as
 * available. The default model, however, is "gemini-3-flash-preview"
 * (ModelToggle.DEFAULT_MODEL_ID), for which no key is configured in CI;
 * ChatInput.handleSubmit then refuses to send. So every LLM spec has to switch
 * the model first.
 *
 * ModelToggle renders a Radix DropdownMenu: the trigger is a button whose title
 * is "Choose model" (current model available) or "API key missing for selected
 * model" (current model not available — the default-Gemini case).
 */
export async function selectClaudeModel(page: Page) {
    const trigger = page
        .locator(
            'button[title="Choose model"], button[title="API key missing for selected model"]',
        )
        .first();
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
    await page.getByRole("menuitem", { name: CLAUDE_MODEL_LABEL }).click();
    // After selection the trigger label reflects the chosen model.
    await expect(
        page.getByRole("button", { name: CLAUDE_MODEL_LABEL }),
    ).toBeVisible({ timeout: 5_000 });
}

/**
 * Creates a new project via the "New project" modal and waits until
 * NewProjectModal's onCreated handler redirects to /projects/<id>.
 *
 * Pass `filePath` to also upload a document during creation.
 */
export async function createProject(
    page: Page,
    projectName: string,
    filePath?: string,
) {
    /* Creation is a navigation + modal wizard + (optionally) a file upload; the
       per-test `{ timeout }` option passed to test() is silently ignored by
       Playwright (that object only accepts tag/annotation), so raise the budget
       here, where the slow work happens, for every caller. */
    test.setTimeout(60_000);

    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/, { timeout: 10_000 });

    /* The Plus icon button in the header has aria-label="New project" */
    const createBtn = page.getByRole("button", { name: "New project" });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    const nameInput = page.getByPlaceholder("Project name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(projectName);

    /* NewProjectModal is a two-step wizard: "Details" (name / CM number /
       practice / colleagues) then "Add Documents". Only the second step has a
       submit button — the first step's primary action is a plain "Next". */
    await page.getByRole("button", { name: "Next", exact: true }).click();

    if (filePath) {
        /* On the documents step the footer "Upload" button opens a hidden file
           input, and its label gains a "(n)" count once files are attached. */
        const fileChooserPromise = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: /^Upload/ }).click();
        (await fileChooserPromise).setFiles(filePath);
        await expect(
            page.getByRole("button", { name: /^Upload \(1\)/ }),
        ).toBeVisible({ timeout: 5_000 });
    }

    /* Submit — NewProjectModal's onCreated calls router.push(`/projects/${id}`).
       The PDF upload runs (awaited) inside handleSubmit before onCreated fires,
       so allow extra time for navigation when a file is attached.

       (The modal's FileDirectory used to fan out a getProject() request per
       existing project on open, which could overwhelm the local Supabase
       gateway and required settle-waits plus a submit-retry loop here. The
       directory now loads via one batched listProjects?include=documents
       request, so a single submit is reliable.)

       The documents step's primary action submits the form (its label flips
       to "Creating…" while in flight, so match on the submit type instead). */
    const navTimeout = filePath ? 30_000 : 15_000;
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/projects\/.+/, { timeout: navTimeout });
}

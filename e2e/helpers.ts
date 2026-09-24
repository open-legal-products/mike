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

/** Anthropic model available through the CI provider fixture or a local live key. */
export const CLAUDE_MODEL_LABEL = "Claude Sonnet 4.6";

/** Select through the shared model picker's accessible trigger and provider group. */
export async function selectClaudeModel(page: Page) {
    const trigger = page.getByRole("button", { name: "Choose model", exact: true });
    await expect(trigger).toBeEnabled({ timeout: 10_000 });
    await trigger.click();
    const provider = page.getByRole("menuitem", { name: "Anthropic", exact: true });
    await expect(provider).toBeVisible();
    if (await provider.getAttribute("aria-expanded") !== "true") {
        await provider.click();
    }
    await page.getByRole("menuitem", { name: CLAUDE_MODEL_LABEL, exact: true }).click();
    await expect(trigger).toHaveAttribute("title", `Choose model — ${CLAUDE_MODEL_LABEL}`);
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
    /* Creation is a navigation + a three-step wizard + (optionally) a file
       upload; the per-test `{ timeout }` option passed to test() is silently
       ignored by Playwright (that object only accepts tag/annotation), so
       raise the budget here, where the slow work happens.

       Only ever raise it: callers such as critical-path already set a larger
       budget for a flow that continues into a live LLM turn, and lowering it
       here would cut that flow short. `timeout: 0` means "no timeout" and is
       left alone. `test.info()` throws outside a running test, and this
       helper's whole point is being callable from anywhere. */
    const budget = filePath ? 90_000 : 60_000;
    try {
        const current = test.info().timeout;
        if (current !== 0 && current < budget) test.setTimeout(budget);
    } catch {
        // Not inside a test: the caller owns its own timeout.
    }

    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/, { timeout: 10_000 });

    /* The Plus icon button in the header has aria-label="New project" */
    const createBtn = page.getByRole("button", { name: "New project" });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    const nameInput = page.getByPlaceholder("Project name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(projectName);

    /* NewProjectModal is a three-step wizard: Details, Access, then Add
       Documents. Project creation happens only from the final step. */
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Access" })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
        page.getByRole("dialog", { name: "Add Documents" }),
    ).toBeVisible();

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

    /* Create — NewProjectModal's onCreated calls router.push(`/projects/${id}`).
       The PDF upload runs (awaited) inside handleSubmit before onCreated fires,
       so allow extra time for navigation when a file is attached.

       (The modal's FileDirectory used to fan out a getProject() request per
       existing project on open, which could overwhelm the local Supabase
       gateway and required settle-waits plus a submit-retry loop here. The
       directory now loads via one batched listProjects?include=documents
       request, so a single submit is reliable.)

       The documents step's primary action is a button whose label flips to
       "Creating…" while in flight. */
    const navTimeout = filePath ? 30_000 : 15_000;
    await page.getByRole("button", { name: "Create project" }).click();
    await page.waitForURL(/\/projects\/.+/, { timeout: navTimeout });
}

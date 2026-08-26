/**
 * E2E tests for Workflows and Settings features.
 *
 * Test user: e2e@mike.local / E2eTestPass1! (session loaded from e2e/.auth/user.json)
 *
 * Key source facts used by these selectors:
 *  - WorkflowList.tsx: h1 "Workflows"; Plus icon button (no aria-label) opens NewWorkflowModal
 *  - NewWorkflowModal.tsx: placeholder "Workflow name"; submit button text "Create workflow"
 *  - New accounts receive editable default workflows, including "Proofread"
 *  - WorkflowPromptEditor.tsx: editorProps class = "workflow-editor-content" on the ProseMirror div
 *  - WorkflowDetailPage save status: text "Saving…" → "Saved" rendered in a plain <span>
 *  - settings/page.tsx: h2 "Profile"; display name autosaves on blur
 *  - settings/layout.tsx: h1 "Settings" in layout header
 *  - settings/models/page.tsx: h2 "API Keys"; label texts include "Anthropic (Claude) API Key" etc.
 */
import { test, expect, type Page } from "@playwright/test";

/**
 * Create a workflow from an already-open NewWorkflowModal and wait for the
 * post-create navigation to /workflows/<id>.
 */
async function createWorkflowAndOpenDetail(page: Page, title: string) {
    const nameInput = page.getByPlaceholder("Workflow name");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(title);

    // Match the submit button in BOTH states: its label is "Create workflow" when
    // idle and "Creating…" while the request is in flight.
    const createBtn = page.getByRole("button", {
        name: /create workflow|creating/i,
    });
    await expect(createBtn).toBeEnabled({ timeout: 10_000 });
    await createBtn.click();
    await expect(page).toHaveURL(/\/workflows\/.+/, { timeout: 15_000 });
}

/* ─────────────────────────────────────────────────────────────────────────────
   WORKFLOWS
───────────────────────────────────────────────────────────────────────────── */

test.describe("Workflows", () => {
    /* ── Test 1: list page loads and shows default workflows ─────────────── */

    test("workflow list page loads and shows default workflows", async ({
        page,
    }) => {
        await page.goto("/workflows");

        // REGRESSION: fails if the /workflows route or page component is broken
        await expect(page).toHaveURL(/\/workflows/, { timeout: 10_000 });

        // The WorkflowList renders an h1 heading
        await expect(
            page.getByRole("heading", { name: "Workflows" }),
        ).toBeVisible({ timeout: 10_000 });

        // Default workflows are installed as user-owned rows on first use.
        // REGRESSION: fails if default installation or workflow rendering breaks.
        await expect(page.getByText("Proofread", { exact: true })).toBeVisible({
            timeout: 10_000,
        });
    });

    /* ── Test 2: create a custom workflow ──────────────────────────────────── */

    test("create a custom assistant workflow and navigate to its detail page", async ({
        page,
    }) => {
        await page.goto("/workflows");
        await expect(
            page.getByRole("heading", { name: "Workflows" }),
        ).toBeVisible({ timeout: 10_000 });

        // The Plus icon button (no aria-label) is the last button inside the div
        // that directly contains the h1 "Workflows" heading.  The only other button
        // in that container is the HeaderSearchBtn search toggle, which comes first.
        // TODO: verify selector if the page header layout changes
        const newWorkflowBtn = page
            .locator("div:has(> h1:has-text('Workflows')) button")
            .last();
        await expect(newWorkflowBtn).toBeVisible({ timeout: 5_000 });
        await newWorkflowBtn.click();

        // The NewWorkflowModal opens — its breadcrumb reads "New workflow"
        await expect(page.getByText("New workflow")).toBeVisible({
            timeout: 5_000,
        });

        // Fill the title, submit, and wait for the post-create router.push to
        // /workflows/<id>. Type defaults to "Assistant" — no change needed.
        // REGRESSION: a broken workflow-create API never navigates, so the
        // helper's toHaveURL assertion fails.
        const workflowTitle = `E2E Workflow ${Date.now()}`;
        await createWorkflowAndOpenDetail(page, workflowTitle);

        // The detail page shows the newly created workflow's title
        await expect(
            page
                .getByText(workflowTitle, { exact: true })
                .filter({ visible: true })
                .first(),
        ).toBeVisible({ timeout: 10_000 });
    });

    /* ── Test 3: installed default workflows remain editable ──────────────── */

    test("installed default workflow opens as an editable user workflow", async ({
        page,
    }) => {
        await page.goto("/workflows");
        const defaultWorkflow = page.getByText("Proofread", { exact: true });
        await expect(defaultWorkflow).toBeVisible({ timeout: 10_000 });
        await defaultWorkflow.click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();

        await expect(page).toHaveURL(/\/workflows\/assistant\/.+/, {
            timeout: 10_000,
        });
        await expect(
            page.getByRole("main").getByText("Proofread", { exact: true }).first(),
        ).toBeVisible();

        // Defaults are ordinary user-owned workflow rows, so their prompt can be edited.
        const editorDiv = page.locator(".ProseMirror");
        await expect(editorDiv).toBeVisible({ timeout: 15_000 });
        await expect(editorDiv).toHaveAttribute("contenteditable", "true", {
            timeout: 5_000,
        });
    });

    /* ── Test 4: custom workflow prompt auto-saves on change ───────────────── */

    test("editing a custom workflow prompt triggers auto-save", async ({
        page,
    }) => {
        /* Step 1: create a fresh custom workflow to edit */
        await page.goto("/workflows");
        await expect(
            page.getByRole("heading", { name: "Workflows" }),
        ).toBeVisible({ timeout: 10_000 });

        // TODO: verify selector if the page header layout changes
        const newWorkflowBtn = page
            .locator("div:has(> h1:has-text('Workflows')) button")
            .last();
        await newWorkflowBtn.click();

        const workflowTitle = `E2E Edit Workflow ${Date.now()}`;
        await createWorkflowAndOpenDetail(page, workflowTitle);
        /* No "networkidle" wait: the editor is dynamically imported, so network
           quiet says nothing about whether it has mounted. The expect() below
           waits on the editor itself, which is what this test types into. */

        /* Step 2: type into the WorkflowPromptEditor */
        // The editor is dynamically imported; wait until it is ready.
        // When readOnly=false (custom workflow), contenteditable="true".
        const editorDiv = page.locator(".ProseMirror");
        await expect(editorDiv).toBeVisible({ timeout: 15_000 });
        await expect(editorDiv).toHaveAttribute("contenteditable", "true", {
            timeout: 5_000,
        });

        await editorDiv.click();
        await page.keyboard.type("This is an E2E test prompt.");

        /* Step 3: the debounced auto-save (800 ms) fires and the save-status
           span transitions: "" → "Saving…" → "Saved".

           save() (workflows/[id]/page.tsx:122-138) sets "Saving…" synchronously
           on every edit, then PATCHes prompt_md and sets "Saved" (which
           auto-reverts to idle after ~2 s).

           REGRESSION: a removed/broken update API or save wiring shows NEITHER
           "Saving…" (guard #1, save() never fires) NOR "Saved" (guard #2, the
           PATCH never resolves), so this fails for a genuine break. */
        // Guard #1: the save() handler must run (sets "Saving…" synchronously).
        // PageHeader renders its actions twice — a desktop inline copy and a
        // portal-mounted mobile copy — so an unscoped text locator resolves to
        // two nodes and trips strict mode. Filter to the visible instance.
        await expect(
            page
                .getByText(/^(Saving…|Saved)$/)
                .filter({ visible: true })
                .first(),
        ).toBeVisible({ timeout: 10_000 });
        // Guard #2: the PATCH must resolve to "Saved".
        await expect(
            page.getByText("Saved").filter({ visible: true }).first(),
        ).toBeVisible({ timeout: 10_000 });
    });
});

/* ─────────────────────────────────────────────────────────────────────────────
   SETTINGS
───────────────────────────────────────────────────────────────────────────── */

test.describe("Settings", () => {
    /* ── Test 5: settings page loads with user info ────────────────────────── */

    test("settings page loads and shows user email", async ({
        page,
    }) => {
        await page.goto("/settings");

        // The settings layout renders a "Settings" h1
        // REGRESSION: fails if the settings page or its layout is broken
        await expect(
            page.getByRole("heading", { name: "Settings" }),
        ).toBeVisible({ timeout: 10_000 });

        // The Profile section has its own h2
        await expect(
            page.getByRole("heading", { name: "Profile" }),
        ).toBeVisible({ timeout: 10_000 });

        // The email is rendered in the (editable) Email input, so assert its
        // value rather than page text.
        // REGRESSION: fails if user auth context is not propagated to the settings page
        await expect(page.getByPlaceholder("Enter your email")).toHaveValue(
            "e2e@mike.local",
            { timeout: 10_000 },
        );
    });

    /* ── Test 6: update display name ─────────────────────────────────────── */

    test("updating display name saves and persists across navigation", async ({
        page,
    }) => {
        // This test bounds-retries its mutation + persistence steps to converge
        // past a real client-side hydration race (see below), so give it more
        // headroom than the 30 s default.
        test.setTimeout(120_000);
        await page.goto("/settings");
        await expect(
            page.getByRole("heading", { name: "Settings" }),
        ).toBeVisible({ timeout: 10_000 });

        // The Display Name Input has placeholder "Enter your name"
        const nameInput = page.getByPlaceholder("Enter your name");
        await expect(nameInput).toBeVisible({ timeout: 10_000 });

        const newName = `E2E Test User ${Date.now()}`;

        const nameStatus = nameInput
            .locator("xpath=../..")
            .locator('[aria-live="polite"]');

        // Robustly save the new name and verify it persists. This retry exists
        // for a real client-side hazard, independent of infrastructure:
        //
        //  Async hydration race. The settings page hydrates this input from a profile
        //  fetch (UserProfileContext → `if (profile?.displayName) setDisplayName(...)`).
        //  Under cold-start the auth state can settle late and trigger a SECOND profile
        //  fetch that overwrites the field AFTER we type. We therefore (re)fill
        //  immediately before blurring and re-verify the persisted value; if a
        //  late overwrite slipped a stale value in, the persist check fails and
        //  the block re-runs after auth has settled.
        //
        // REGRESSION: a broken profile PATCH / save handler never reaches "Saved" and never
        // persists newName, so every attempt fails and toPass exhausts → the test fails.
        await expect(async () => {
            // Reload at the START of each attempt so a failed or stale profile GET
            // (which leaves the input empty via the null-displayName fallback, with no
            // client-side refetch) is retried with a fresh fetch rather than looping on a
            // permanently-empty page.
            //
            // Hydration signal: wait for the profile GET itself, not for a non-empty
            // input. A fresh e2e user (fresh database) has displayName=null, so
            // "input pre-filled with the stored name" can never happen on the
            // first-ever run — the old not.toHaveValue("") wait deadlocked there.
            const profileLoaded = page.waitForResponse(
                (resp) =>
                    resp.url().endsWith("/user/profile") &&
                    resp.request().method() === "GET" &&
                    resp.ok(),
                { timeout: 10_000 },
            );
            await page.goto("/settings");
            await profileLoaded;
            await nameInput.fill(newName);
            await expect(nameInput).toHaveValue(newName, { timeout: 2_000 });

            await nameInput.press("Tab");
            await expect(nameStatus).toHaveText("Saved", { timeout: 8_000 });

            // Navigate away and back; the freshly fetched profile must show newName.
            await page.goto("/assistant");
            await page.goto("/settings");
            await expect(nameInput).toHaveValue(newName, { timeout: 8_000 });
        }).toPass({ timeout: 90_000 });
    });

    /* ── Test 7: API keys page loads and shows all three provider sections ── */

    test("API keys page loads and shows Anthropic, Google, and OpenAI sections", async ({
        page,
    }) => {
        // API keys were split out of /settings/models into their own settings
        // page (the "API Keys" sidebar entry) — /settings/models now holds only
        // model preferences.
        await page.goto("/settings/byok");

        // The shared settings layout still renders "Settings"
        await expect(
            page.getByRole("heading", { name: "Settings" }),
        ).toBeVisible({ timeout: 10_000 });

        // The h2 "API Keys" section is present
        // REGRESSION: fails if the /settings/byok page is broken or the API Keys section is removed
        await expect(
            page.getByRole("heading", { name: "API Keys" }),
        ).toBeVisible({ timeout: 10_000 });

        // All three provider label texts (from MODEL_API_KEY_FIELDS in api-keys/page.tsx) must appear
        // REGRESSION: fails if any provider section is removed from the API keys page
        await expect(
            page.getByText("Anthropic (Claude) API Key"),
        ).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText("Google (Gemini) API Key")).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.getByText("OpenAI API Key")).toBeVisible({
            timeout: 10_000,
        });
    });
});

/**
 * Tabular Review E2E tests:
 *   1. Navigate to /tabular-reviews — the list page loads correctly
 *   2. Create a new tabular review — modal flow, API call, redirect to detail
 *   3. Review detail page — table structure and toolbar controls render
 *   4. Add a document — upload via AddDocumentsModal, row appears in table
 *
 * Prerequisite: auth.setup.ts has already saved the session to e2e/.auth/user.json
 * Test user: e2e@mike.local / E2eTestPass1! (storageState inherited from playwright.config.ts)
 */
import { test, expect } from "@playwright/test";
import { PDF_FIXTURE } from "./helpers";

// Run these tests sequentially in a single worker: they share the one test
// user's review list, so concurrent create/detail runs would race each other.
test.describe.configure({ mode: "serial" });

/* ─── Helpers ────────────────────────────────────────────────────────────── */

/**
 * Click the "New review" Plus icon button in the Tabular Reviews list-page header.
 *
 * The button has no aria-label or visible text — it is an icon-only button
 * rendered immediately after the HeaderSearchBtn (magnifier icon) in the same
 * flex container that is the sibling of the <h1>Tabular Reviews</h1>.
 *
 * DOM structure:
 *   <div class="… justify-between …">
 *     <h1>Tabular Reviews</h1>
 *     <div class="flex items-center gap-2">   ← xpath=../div[1] from h1
 *       <div>…<button>{SearchIcon}</button></div>   ← HeaderSearchBtn
 *       <button>{PlusIcon}</button>                 ← new-review button (.last())
 *     </div>
 *   </div>
 *
 * TODO: once aria-label="New review" is added to that button, replace with:
 *   page.getByRole("button", { name: "New review" })
 */
async function clickNewReviewBtn(page: import("@playwright/test").Page) {
    // Walk from the h1 to the parent div, then select its first div child
    // (the actions container); the last button within it is the Plus icon.
    const actionsDiv = page
        .getByRole("heading", { name: "Tabular Reviews" })
        .locator("xpath=../div[1]"); // TODO: verify selector
    await actionsDiv.getByRole("button").last().click();
}

/** Predicate matching the create-review request: POST /tabular-review (exact). */
const isCreateReviewPost = (r: import("@playwright/test").Response) =>
    /\/tabular-review\/?$/.test(new URL(r.url()).pathname) &&
    r.request().method() === "POST";

/**
 * Open the AddNewTRModal (assumes /tabular-reviews is already loaded) and return
 * its "Review name" input once visible.
 */
async function openNewReviewModal(page: import("@playwright/test").Page) {
    await clickNewReviewBtn(page);
    const titleInput = page.getByPlaceholder("Review name");
    await expect(titleInput).toBeVisible({ timeout: 10_000 });
    return titleInput;
}

/**
 * Create a tabular review through the real modal flow and land on its detail
 * page. Returns the title that was entered so callers can assert on it.
 *
 * @param onFirstOpen optional assertion run against the modal on the first open
 *        (used by Test 2 to verify the workflow-template default renders).
 */
async function createReview(
    page: import("@playwright/test").Page,
    label = "E2E Review",
    onFirstOpen?: () => Promise<void>,
): Promise<string> {
    await page.goto("/tabular-reviews");
    await expect(
        page.getByRole("heading", { name: "Tabular Reviews" }),
    ).toBeVisible({ timeout: 10_000 });

    const reviewName = `${label} ${Date.now()}`;

    const titleInput = await openNewReviewModal(page);
    if (onFirstOpen) await onFirstOpen();
    await titleInput.fill(reviewName);

    // NewTRModal is a two-step wizard ("Details" → "Add Documents"); the
    // "Create" submit button only exists on the second step, and "Next" only
    // enables once the review has a name.
    await page.getByRole("button", { name: "Next", exact: true }).click();

    const respP = page.waitForResponse(isCreateReviewPost, {
        timeout: 30_000,
    });
    // The modal footer's submit button and the page's own "Create" CTA both
    // read "Create"; scope to the modal's submit (button[name="modalAction"]
    // value="create-review") to avoid a strict-mode ambiguity.
    await page
        .locator('button[name="modalAction"][value="create-review"]')
        .click();
    const resp = await respP;
    expect(
        resp.ok(),
        `POST /tabular-review returned ${resp.status()} — create flow broken?`,
    ).toBe(true);
    const review = (await resp.json()) as { id: string };

    // createTabularReview() → router.push("/tabular-reviews/<id>").
    await expect(page).toHaveURL(
        new RegExp(`/tabular-reviews/${review.id}`),
        { timeout: 30_000 },
    );

    return reviewName;
}

/* ─── Test 1: list page loads ─────────────────────────────────────────────── */

test("navigates to /tabular-reviews and the list page renders", async ({
    page,
}) => {
    // REGRESSION: fails if the /tabular-reviews route is removed or broken
    await page.goto("/tabular-reviews");

    await expect(page).toHaveURL(/\/tabular-reviews/);

    // The page renders an h1 heading with the section title
    await expect(
        page.getByRole("heading", { name: "Tabular Reviews" }),
    ).toBeVisible({ timeout: 10_000 });

    // The ToolbarTabs bar renders the "All" tab
    // TODO: verify selector if ToolbarTabs uses role="tab" instead of role="button"
    await expect(page.getByText("All")).toBeVisible({ timeout: 5_000 });
});

/* ─── Test 2: create a new tabular review ─────────────────────────────────── */

test("creates a new tabular review and is redirected to the detail page", async ({
    page,
}) => {
    // Headroom for the create round-trip plus the first navigation to the
    // dynamic /tabular-reviews/[id] route.
    test.setTimeout(60_000);
    // REGRESSION: fails if createTabularReview() API call is removed or the
    // /tabular-reviews POST route is broken (createReview's response
    // assertion then trips).
    //
    // createReview opens the modal, verifies the workflow-template default
    // renders, submits, and lands on the new review's detail page.
    const reviewName = await createReview(page, "E2E Review", async () => {
        // The workflow template control defaults to "No template - start from
        // scratch" once the templates request resolves (it shows "Loading
        // templates…" until then), so allow time for that listWorkflows() fetch.
        // NewTRModal renders it as a button, with a hyphen — not an em dash.
        await expect(
            page.getByRole("button", { name: "No template - start from scratch" }),
        ).toBeVisible({ timeout: 15_000 });
    });

    // The new review's title appears in the page breadcrumb header
    await expect(
        page.getByText(reviewName, { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 10_000 });
});

/* ─── Test 3: review detail page table structure ─────────────────────────── */

test("review detail page renders the table structure and toolbar controls", async ({
    page,
}) => {
    // Headroom for the create round-trip plus the detail-route navigation.
    test.setTimeout(60_000);
    // REGRESSION: fails if the /tabular-reviews/[id] route, TRView, or TRTable
    // component is broken
    const reviewName = await createReview(page, "E2E Table Review");

    // The breadcrumb header shows the review title via RenameableTitle
    await expect(
        page.getByText(reviewName, { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Depending on the width available to the header actions, the parent
    // breadcrumb is either visible or placed in the overflow menu.
    const parentBreadcrumb = page
        .getByRole("button", { name: "Tabular Reviews", exact: true })
        .filter({ visible: true });
    if (await parentBreadcrumb.first().isVisible()) {
        await expect(parentBreadcrumb.first()).toBeVisible({ timeout: 5_000 });
    } else {
        await page.getByRole("button", { name: "Show collapsed breadcrumbs" }).click();
        await expect(
            page.getByRole("menuitem", { name: "Tabular Reviews", exact: true }),
        ).toBeVisible({ timeout: 5_000 });
        await page.keyboard.press("Escape");
    }

    // TRTable always renders a "Document" column header, even when the review
    // is empty. This is visible in both the empty-state and populated states.
    await expect(
        page.getByText("Document", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // The toolbar renders "Add Columns" and "Add Documents" once loading is done.
    // Both may also appear in TRTable's empty-state CTA, so .first() is used.
    await expect(
        page.getByRole("button", { name: /Add Columns/ }).first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
        page.getByRole("button", { name: /Add Documents/ }).first(),
    ).toBeVisible({ timeout: 5_000 });
});

/* ─── Test 4: add a document to a review ─────────────────────────────────── */

test("adds a document to a tabular review and the row appears in the table", async ({
    page,
}) => {
    // Headroom for the create round-trip plus the upload + document-link
    // round-trips.
    test.setTimeout(90_000);
    // REGRESSION: fails if the document-to-review linking
    // (PATCH /tabular-reviews/:id with document_ids) or the upload endpoint breaks
    const reviewName = await createReview(page, "E2E Doc Review");
    // reviewName is already confirmed visible on the detail page by createReview

    const row = page.getByText("test.pdf").first();
    const confirmBtn = page.getByRole("button", { name: "Confirm" });

    // Open AddDocumentsModal (standalone path → AddDocumentsModal, not
    // AddProjectDocsModal). first() handles both toolbar & empty-state CTA.
    const addDocsBtn = page
        .getByRole("button", { name: /Add Documents/ })
        .first();
    await expect(addDocsBtn).toBeVisible({ timeout: 10_000 });
    await addDocsBtn.click();

    // The footer's "Upload" button programmatically clicks a hidden
    // <input type="file"> — Playwright intercepts it as a file-chooser event.
    const uploadBtn = page.getByRole("button", { name: "Upload" });
    await expect(uploadBtn).toBeVisible({ timeout: 5_000 });
    const fileChooserPromise = page.waitForEvent("filechooser");
    await uploadBtn.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(PDF_FIXTURE);

    // After a successful upload the server document is auto-selected and the
    // "Confirm" button transitions disabled → enabled.
    await expect(confirmBtn).toBeEnabled({ timeout: 20_000 });

    // Confirm → onSelect() → handleAddDocuments() → updateTabularReview()
    // PATCH → setDocuments() → TRTable renders the new row with doc.filename.
    await confirmBtn.click();
    await expect(row).toBeVisible({ timeout: 15_000 });
});

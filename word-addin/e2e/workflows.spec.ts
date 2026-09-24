/**
 * E2E coverage for the Workflows flow (WorkflowPicker.tsx).
 *
 * The pane starts signed-in (seeded token). Opening the Workflows page mounts
 * WorkflowPicker, which:
 *   - GET /workflows           -> full-pane searchable list, filtered to
 *                                 metadata.type==="assistant" with non-empty
 *                                 skill_md; clicking a row opens its skill
 *                                 content with Back and Use controls in the
 *                                 floating header
 *   - Use                      -> returns to Assistant and attaches the workflow
 *                                 to the chat composer for the next message
 *
 * All network is mocked via the shared fixture; no live backend is contacted.
 */
import { test, expect } from "./support/fixtures";

const TOKEN = "wf-test-token";

/** A representative GET /workflows payload mixing runnable and non-runnable rows. */
const WORKFLOWS = [
  {
    id: "wf-summary",
    user_id: "user-1",
    metadata: {
      title: "Summarize document",
      description: null,
      type: "assistant",
      contributors: [],
      language: "English",
      version: "1.2",
      practice: "Litigation",
      jurisdictions: ["Singapore"],
    },
    skill_md: "# Summarize document\n\nSummarize the document.",
    columns_config: null,
    is_system: false,
    created_at: "2026-08-07T00:00:00Z",
    allow_edit: true,
    is_owner: true,
  },
  {
    id: "wf-risks",
    metadata: { title: "Identify risks", type: "assistant", practice: null },
    skill_md: "List the key risks.",
  },
  // Filtered out: tabular workflows need a different endpoint.
  {
    id: "wf-table",
    metadata: {
      title: "Extract parties table",
      type: "tabular",
      practice: null,
    },
    skill_md: "columns: party, role",
  },
  // Filtered out: assistant but blank skill_md => not runnable.
  {
    id: "wf-empty",
    metadata: {
      title: "Blank prompt workflow",
      type: "assistant",
      practice: null,
    },
    skill_md: "   ",
  },
];

/** Sign in, register the workflow-list mock, mount the pane, open the page. */
async function openWorkflows(
  addin: import("./support/fixtures").Addin,
  workflows: unknown,
  documentText = "This Agreement is between Acme and Beta.",
): Promise<void> {
  addin.seedToken(TOKEN);
  // listWorkflows("assistant") requests /workflows?type=assistant, so the glob
  // must allow the query string (** matches the trailing ?type=…).
  await addin.mockApiJson("GET", "**/workflows**", workflows);
  await addin.gotoTaskpane({ documentText });
  await addin.expectAuthedShell();
  await addin.page.getByRole("button", { name: "Open menu" }).click();
  await addin.page.getByRole("menuitem", { name: "Workflows" }).click();
}

test("shows a full-pane workflow list and opens skill details", async ({
  addin,
  page,
}) => {
  await openWorkflows(addin, WORKFLOWS);

  await expect(page.getByTestId("workflows-full-screen")).toBeVisible();
  await expect(page.getByTestId("workflows-page-title")).toHaveClass(
    /font-serif/,
  );
  await expect(page.getByTestId("workflows-page-title")).toHaveClass(
    /text-2xl/,
  );
  await expect(page.getByTestId("workflows-page-title")).toHaveClass(
    /font-medium/,
  );
  await expect(page.getByPlaceholder("Search workflows...")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add-ons" })).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  const summaryRow = page.getByRole("button", {
    name: /Summarize document.*Litigation/,
  });
  await expect(summaryRow).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Identify risks" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run workflow on document" }),
  ).toHaveCount(0);

  await summaryRow.click();
  const header = page.getByTestId("floating-header");
  await expect(
    header.getByRole("button", { name: "Back to workflows" }),
  ).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Use", exact: true }),
  ).toBeVisible();
  await expect(header.getByTestId("workflow-back-bubble")).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Back to workflows" }).locator("svg"),
  ).toHaveCount(1);
  await expect(
    header.getByRole("button", { name: "Back to workflows" }),
  ).toContainText("Workflows");
  await expect(
    header.getByRole("button", { name: "Use", exact: true }).locator("svg"),
  ).toHaveCount(1);
  const actionsButton = header.getByRole("button", {
    name: "Workflow actions",
  });
  await expect(actionsButton).toBeVisible();
  await expect(actionsButton.locator("svg")).toHaveCount(1);
  const actionsBounds = await actionsButton.boundingBox();
  const useBounds = await header
    .getByRole("button", { name: "Use", exact: true })
    .boundingBox();
  expect(actionsBounds).not.toBeNull();
  expect(useBounds).not.toBeNull();
  expect(actionsBounds!.x).toBeLessThan(useBounds!.x);
  await expect(page.getByTestId("workflow-skill-content")).toContainText(
    "Summarize the document.",
  );
  await expect(page.getByTestId("workflow-detail-title")).toHaveClass(
    /font-serif/,
  );
  await expect(page.getByTestId("workflow-detail-title")).toHaveClass(
    /text-2xl/,
  );
  await expect(page.getByTestId("workflow-detail-title")).toHaveClass(
    /font-medium/,
  );
  await expect(page.getByTestId("workflow-skill-body")).toHaveClass(
    /font-sans/,
  );
  await expect(
    page.getByTestId("workflow-skill-body").locator("h1"),
  ).toHaveCount(0);
  await expect(page.getByText("Skill", { exact: true })).toHaveCount(0);
  await expect(
    page.getByTestId("workflow-detail-title").locator(".."),
  ).not.toContainText("Litigation");
  await expect(
    page.getByRole("button", { name: "Run workflow on document" }),
  ).toHaveCount(0);

  await header.getByRole("button", { name: "Back to workflows" }).click();
  await expect(page.getByPlaceholder("Search workflows...")).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Use", exact: true }),
  ).toHaveCount(0);
});

test("creates an assistant workflow and edits its Markdown with Tiptap", async ({
  addin,
  page,
}) => {
  const createdWorkflow = {
    ...WORKFLOWS[0],
    id: "wf-created",
    metadata: {
      ...WORKFLOWS[0]!.metadata,
      title: "Review defined terms",
      version: null,
      practice: "Corporate",
      jurisdictions: ["Singapore"],
    },
    skill_md: null,
  };
  const editedWorkflow = {
    ...createdWorkflow,
    skill_md: "Review every defined term for consistency.",
  };

  await openWorkflows(addin, WORKFLOWS);
  await addin.mockApiJson("POST", "**/workflows", createdWorkflow, {
    status: 201,
  });
  await addin.mockApiJson("PATCH", "**/workflows/wf-created", editedWorkflow);

  const header = page.getByTestId("floating-header");
  const newWorkflowButton = header.getByRole("button", {
    name: "New workflow",
  });
  await expect(newWorkflowButton).toBeVisible();
  await newWorkflowButton.click();

  const modal = page.getByRole("dialog", { name: "New workflow" });
  await expect(modal).toBeVisible();
  await expect(modal.getByText("Type", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("Assistant", { exact: true })).toHaveCount(0);
  const titleInput = modal.getByLabel("Title");
  await expect(titleInput).not.toHaveClass(/font-medium/);
  await titleInput.pressSequentially("Review defined terms");
  await expect(titleInput).toBeFocused();
  await expect(modal.getByRole("button", { name: "Close" })).not.toBeFocused();
  await modal.getByLabel("Practice area").click();
  await page.getByRole("menuitem", { name: "Corporate", exact: true }).click();
  await modal.getByLabel("Jurisdiction").click();
  await page.getByRole("menuitem", { name: "Singapore", exact: true }).click();

  const createRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/workflows"),
  );
  await modal.getByRole("button", { name: "Create workflow" }).click();
  const createBody = (await createRequest).postDataJSON();
  expect(createBody).toEqual({
    metadata: {
      title: "Review defined terms",
      type: "assistant",
      language: "English",
      practice: "Corporate",
      jurisdictions: ["Singapore"],
    },
  });

  await expect(page.getByTestId("workflow-detail-title")).toHaveText(
    "Review defined terms",
  );
  await expect(newWorkflowButton).toHaveCount(0);
  const editor = page.locator(".workflow-editor-content");
  await expect(editor).toBeVisible();
  await expect(header.getByRole("button", { name: "Use" })).toBeVisible();

  const updateRequest = page.waitForRequest(
    (request) =>
      request.method() === "PATCH" &&
      new URL(request.url()).pathname.endsWith("/workflows/wf-created"),
  );
  await editor.fill("Review every defined term for consistency.");
  const updateBody = (await updateRequest).postDataJSON();
  expect(updateBody.skill_md).toContain(
    "Review every defined term for consistency.",
  );
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Show raw Markdown" }).click();
  await expect(page.getByLabel("Raw Markdown")).toHaveValue(
    "Review every defined term for consistency.",
  );
});

test("opens and saves editable workflow metadata from the header", async ({
  addin,
  page,
}) => {
  const updatedWorkflow = {
    ...WORKFLOWS[0],
    metadata: {
      ...WORKFLOWS[0]!.metadata,
      title: "Updated summary workflow",
      language: "French",
      practice: "Corporate",
      jurisdictions: ["Hong Kong"],
    },
  };
  await openWorkflows(addin, WORKFLOWS);
  const skillPatchControl = {
    releaseResponse: (): void => undefined,
    markSeen: (): void => undefined,
  };
  const allowSkillPatchResponse = new Promise<void>((resolve) => {
    skillPatchControl.releaseResponse = resolve;
  });
  const skillPatchSeen = new Promise<void>((resolve) => {
    skillPatchControl.markSeen = resolve;
  });
  await page.route("**/workflows/wf-summary", async (route, request) => {
    if (request.method() !== "PATCH") return route.fallback();
    const body = request.postDataJSON() as {
      metadata?: unknown;
      skill_md?: string;
    };
    if (!body.metadata) {
      skillPatchControl.markSeen();
      await allowSkillPatchResponse;
    }
    const response = body.metadata
      ? updatedWorkflow
      : {
          ...WORKFLOWS[0],
          skill_md: body.skill_md ?? WORKFLOWS[0]!.skill_md,
        };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });

  await page
    .getByRole("button", { name: /Summarize document.*Litigation/ })
    .click();
  await page.getByRole("button", { name: "Workflow actions" }).click();
  await page.getByRole("menuitem", { name: "Edit details" }).click();

  const modal = page.getByRole("dialog", { name: "View and Edit details" });
  await expect(modal).toBeVisible();
  await expect(modal.getByText("Assistant", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("User", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("1.2", { exact: true })).toHaveCount(0);
  await expect(modal.getByLabel("Title")).toHaveValue("Summarize document");
  await expect(modal.getByLabel("Language")).toContainText("English");
  await expect(modal.getByLabel("Practice area")).toContainText("Litigation");
  await expect(modal.getByLabel("Jurisdiction")).toContainText("Singapore");

  await modal.getByLabel("Title").fill("Updated summary workflow");
  await skillPatchSeen;
  const backgroundSaveResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== "PATCH" ||
      !new URL(response.url()).pathname.endsWith("/workflows/wf-summary")
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as {
      skill_md?: unknown;
    } | null;
    return !!body?.skill_md;
  });
  skillPatchControl.releaseResponse();
  await backgroundSaveResponse;
  await expect(modal.getByLabel("Title")).toHaveValue(
    "Updated summary workflow",
  );
  await modal.getByLabel("Language").click();
  await page.getByRole("menuitem", { name: "French", exact: true }).click();
  await modal.getByLabel("Practice area").click();
  await page.getByRole("menuitem", { name: "Corporate", exact: true }).click();
  await modal.getByLabel("Jurisdiction").click();
  await page.getByRole("menuitem", { name: "Hong Kong", exact: true }).click();

  const requestPromise = page.waitForRequest((request) => {
    if (
      request.method() !== "PATCH" ||
      !new URL(request.url()).pathname.endsWith("/workflows/wf-summary")
    ) {
      return false;
    }
    const body = request.postDataJSON() as { metadata?: unknown } | null;
    return !!body?.metadata;
  });
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  const body = (await requestPromise).postDataJSON();
  expect(body).toEqual({
    metadata: {
      title: "Updated summary workflow",
      language: "French",
      practice: "Corporate",
      jurisdictions: ["Hong Kong"],
    },
  });
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId("workflow-detail-title")).toHaveText(
    "Updated summary workflow",
  );

  await page.getByRole("button", { name: "Back to workflows" }).click();
  await expect(
    page.getByRole("button", { name: /Updated summary workflow.*Corporate/ }),
  ).toBeVisible();
});

test("hides tabular and empty-prompt workflows", async ({ addin, page }) => {
  await openWorkflows(addin, WORKFLOWS);

  await expect(page.getByText("Extract parties table")).toHaveCount(0);
  await expect(page.getByText("Blank prompt workflow")).toHaveCount(0);
});

test("shows an empty state when no runnable workflows exist", async ({
  addin,
  page,
}) => {
  // Only non-runnable rows => filtered list is empty.
  await openWorkflows(addin, [WORKFLOWS[2], WORKFLOWS[3]]);

  await expect(page.getByText("No workflows found.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run workflow on document" }),
  ).toHaveCount(0);
});

test("shows an empty state when the list response is empty", async ({
  addin,
  page,
}) => {
  await openWorkflows(addin, []);

  await expect(page.getByText("No workflows found.")).toBeVisible();
});

test("surfaces an error when the workflow list fails to load", async ({
  addin,
  page,
}) => {
  addin.seedToken(TOKEN);
  await addin.mockApiError("GET", "**/workflows**", 500, "boom");
  await addin.gotoTaskpane({ documentText: "Doc" });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Workflows" }).click();

  // listWorkflows() throws a MikeApiError; the 500 body ("boom") is never
  // shown, only the classified sentence, and a toast carries the Retry.
  await expect(
    page.getByText("Something went wrong on our side. Try again.").first(),
  ).toBeVisible();
  await expect(page.getByText(/boom/)).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText(
    "Couldn't load your workflows",
  );
  await expect(
    page.getByRole("button", { name: "Run workflow on document" }),
  ).toHaveCount(0);
});

test("uses a workflow by attaching it to the Assistant chat input", async ({
  addin,
  page,
}) => {
  await openWorkflows(addin, WORKFLOWS);
  await addin.mockChatStream(["The contract has three key risks."]);

  await page
    .getByRole("button", { name: /Summarize document.*Litigation/ })
    .click();
  await page
    .getByTestId("floating-header")
    .getByRole("button", { name: "Use", exact: true })
    .click();

  await expect(page.getByPlaceholder("How can I help?")).toBeVisible();
  const chatInput = page.getByTestId("chat-input");
  await expect(chatInput.getByText("Summarize document")).toBeVisible();
  await expect(
    chatInput.getByRole("button", {
      name: "Remove workflow Summarize document",
    }),
  ).toBeVisible();
  await expect(page.getByTestId("workflow-skill-content")).toHaveCount(0);

  await page.getByPlaceholder("How can I help?").fill("Review this document");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const request = await requestPromise;
  const body = request.postDataJSON();
  const message = body.messages[body.messages.length - 1];
  expect(message.role).toBe("user");
  expect(message.content).toMatch(/^Review this document/);
  expect(message.workflow).toEqual({
    id: "wf-summary",
    title: "Summarize document",
  });
  expect(body.document_context).toBe(
    "This Agreement is between Acme and Beta.",
  );
  await expect(chatInput.getByText("Summarize document")).toHaveCount(0);
});

test("can go back from one workflow and open another", async ({
  addin,
  page,
}) => {
  await openWorkflows(addin, WORKFLOWS);

  await page
    .getByRole("button", { name: /Summarize document.*Litigation/ })
    .click();
  await page
    .getByTestId("floating-header")
    .getByRole("button", { name: "Back to workflows" })
    .click();
  await page.getByRole("button", { name: "Identify risks" }).click();

  await expect(page.getByTestId("workflow-skill-content")).toContainText(
    "List the key risks.",
  );
  await expect(page.getByText("Summarize the document.")).toHaveCount(0);
});

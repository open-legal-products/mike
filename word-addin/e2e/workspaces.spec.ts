import { test, expect } from "./support/fixtures";
import type { Page, Request } from "@playwright/test";

const TOKEN = "workspace-test-token";
const ORG = "11111111-1111-4111-8111-111111111111";
const FIRM = { id: ORG, name: "Firm LLP", role: "member" };

async function mockOrgs(page: Page, orgs: unknown[][]): Promise<void> {
  // Each read answers with the next list; the last one repeats.
  let call = 0;
  await page.route("**/orgs", (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    const body = orgs[Math.min(call, orgs.length - 1)];
    call += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/** Every history GET, with the workspace it asked for. */
async function recordHistory(
  page: Page,
  answer: (workspace: string | null) => { status: number; body: unknown },
): Promise<(string | null)[]> {
  const workspaces: (string | null)[] = [];
  await page.route("**/word-chat?*", (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    const workspace = new URL(request.url()).searchParams.get("workspace");
    workspaces.push(workspace);
    const { status, body } = answer(workspace);
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return workspaces;
}

async function openSection(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name }).click();
}

/** Chooses the workspace in Settings, then returns to the Assistant. */
async function chooseWorkspace(page: Page, name: string): Promise<void> {
  await openSection(page, "Settings");
  await page.getByRole("button", { name: "Workspace" }).click();
  await page.getByRole("menuitem", { name }).click();
  await expect(page.getByRole("button", { name: "Workspace" })).toHaveText(name);
  await openSection(page, "Assistant");
}

test("Settings offers no Workspace choice without an organization", async ({
  addin,
  page,
}) => {
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await openSection(page, "Settings");
  await expect(
    page.getByRole("switch", { name: "Save chats in the cloud" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Workspace" })).toHaveCount(0);
});

test("the menu has no Workspace section", async ({ addin, page }) => {
  await mockOrgs(page, [[FIRM]]);
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
});

test("a chat started in an organization lists and starts there", async ({
  addin,
  page,
}) => {
  await mockOrgs(page, [[FIRM]]);
  const history = await recordHistory(page, (workspace) => ({
    status: 200,
    body:
      workspace === ORG
        ? [
            {
              id: "org-chat",
              project_id: null,
              user_id: "test-user-id",
              org_id: ORG,
              title: "Firm review",
              created_at: new Date().toISOString(),
            },
          ]
        : [],
  }));
  await addin.mockChatStream(["Filed under the firm."], { chatId: "new-chat" });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await expect.poll(() => history).toEqual(["personal"]);

  await chooseWorkspace(page, "Firm LLP");
  await expect.poll(() => history.at(-1)).toBe(ORG);

  await page.getByRole("button", { name: "Chat history" }).click();
  await expect(
    page.getByTestId("chat-history-list-10").getByRole("menuitem", { name: /Firm review/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByPlaceholder("How can I help?").fill("Review the indemnity");
  const sent: Promise<Request> = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/word-chat"),
  );
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body.org_id).toBe(ORG);
  expect(body.storage).toBe("cloud");
  await expect(page.getByText("Filed under the firm.")).toBeVisible();

  // Personal again: its own history, and a new chat without org_id.
  await chooseWorkspace(page, "Personal");
  await expect.poll(() => history.at(-1)).toBe("personal");
  await page.getByRole("button", { name: "Chat history" }).click();
  await expect(page.getByText("No chats saved for this document")).toBeVisible();
});

test("an organization with chats on the device explains, and the server's refusal shows", async ({
  addin,
  page,
}) => {
  await mockOrgs(page, [[FIRM]]);
  const history = await recordHistory(page, () => ({ status: 200, body: [] }));
  await page.route("**/word-chat", (route, request) => {
    if (request.method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        code: "word_org_chat_requires_cloud",
        detail:
          "Chats in an organization's workspace are saved to your account. Turn on cloud history to chat here.",
      }),
    });
  });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  await openSection(page, "Settings");
  await page.getByRole("switch", { name: "Save chats in the cloud" }).click();
  await chooseWorkspace(page, "Firm LLP");

  await expect(page.getByTestId("workspace-storage-notice")).toHaveText(
    "Chats in Firm LLP are saved to your account. Turn on cloud chat history in Settings to chat here.",
  );
  await page.getByRole("button", { name: "Chat history" }).click();
  await expect(
    page.getByRole("menu").getByText(/Chats in Firm LLP are saved to your account/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // Device-only chats are Personal: nothing is asked of the server for them.
  expect(history.filter((workspace) => workspace === ORG)).toEqual([]);

  await page.getByPlaceholder("How can I help?").fill("Keep this here");
  const sent: Promise<Request> = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/word-chat"),
  );
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ org_id: ORG, storage: "local" });
  await expect(
    page.getByText(/Chats in an organization's workspace are saved to your account/),
  ).toBeVisible();
});

test("a workspace the caller has left falls back to Personal with a notice", async ({
  addin,
  page,
}) => {
  // The first organizations read still lists the firm; the one after the
  // refusal (the caller was removed in the meantime) does not.
  await mockOrgs(page, [[FIRM], []]);
  const history = await recordHistory(page, (workspace) =>
    workspace === ORG
      ? {
          status: 404,
          body: { code: "workspace_not_found", detail: "Workspace not found" },
        }
      : { status: 200, body: [] },
  );
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await expect.poll(() => history).toEqual(["personal"]);

  await chooseWorkspace(page, "Firm LLP");

  await expect.poll(() => history).toEqual(["personal", ORG, "personal"]);
  await expect(page.getByTestId("toast")).toContainText(
    "You're no longer a member of Firm LLP. Showing your Personal workspace.",
  );
  await openSection(page, "Settings");
  await expect(
    page.getByRole("switch", { name: "Save chats in the cloud" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Workspace" })).toHaveCount(0);
});

const NO_KEYS = {
  claude: false,
  gemini: false,
  openai: false,
  openrouter: false,
  courtlistener: false,
};

async function mockOrgKeys(
  page: Page,
  effective: Record<string, boolean>,
  routerModels: Record<string, string[]> = {},
): Promise<string[]> {
  const reads: string[] = [];
  await page.route(`**/orgs/${ORG}/api-keys`, (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    reads.push(new URL(request.url()).pathname);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        keys: effective,
        effective,
        router_models: {},
        effective_router_models: routerModels,
        can_manage: false,
      }),
    });
  });
  return reads;
}

test("the composer can send with an organization-only provider key", async ({
  addin,
  page,
}) => {
  // No key of their own; the organization holds a Gemini key.
  await mockOrgs(page, [[FIRM]]);
  await recordHistory(page, () => ({ status: 200, body: [] }));
  await addin.mockApiJson("GET", "**/user/api-keys", NO_KEYS);
  const orgReads = await mockOrgKeys(page, { ...NO_KEYS, gemini: true });
  await addin.mockChatStream(["Run on the firm's key."], { chatId: "org-key-chat" });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  await expect(page.getByText("No AI provider key is set up.")).toBeVisible();
  expect(orgReads).toEqual([]);

  await chooseWorkspace(page, "Firm LLP");
  await expect.poll(() => orgReads.length).toBeGreaterThan(0);
  await expect(page.getByText(/No AI provider key is set up/)).toHaveCount(0);

  await page.getByPlaceholder("How can I help?").fill("Review the indemnity");
  const sent: Promise<Request> = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/word-chat"),
  );
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body.org_id).toBe(ORG);
  // The profile's last model, which only the organization's key can run.
  expect(String(body.model)).toMatch(/^gemini-/);
  await expect(page.getByText("Run on the firm's key.")).toBeVisible();
});

test("a router-only organization offers its saved models", async ({ addin, page }) => {
  await mockOrgs(page, [[FIRM]]);
  await recordHistory(page, () => ({ status: 200, body: [] }));
  await addin.mockApiJson("GET", "**/user/api-keys", { ...NO_KEYS, openrouter: true });
  await addin.mockApiJson("GET", "**/user/profile", {
    lastSelectedChatModel: "openrouter/openai/personal-choice",
    openRouterModels: ["openai/personal-choice"],
  });
  await mockOrgKeys(page, { ...NO_KEYS, openrouter: true }, {
    openrouter: ["openai/firm-approved"],
  });
  await addin.mockChatStream(["Ran the firm's approved model."], { chatId: "org-router-chat" });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await chooseWorkspace(page, "Firm LLP");

  await page.getByRole("button", { name: "Choose model" }).click();
  await expect(page.getByRole("menuitem", { name: /Personal Choice/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /Firm Approved/ }).click();
  await expect(page.getByText(/No AI provider key is set up/)).toHaveCount(0);

  await page.getByPlaceholder("How can I help?").fill("Review the indemnity");
  const sent = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname.endsWith("/word-chat"),
  );
  await page.getByRole("button", { name: "Send" }).click();
  expect((await sent).postDataJSON()).toMatchObject({
    org_id: ORG,
    model: "openrouter/openai/firm-approved",
  });
  await expect(page.getByText("Ran the firm's approved model.")).toBeVisible();
});

test("Personal keeps profile router choices when the key status is unavailable", async ({ addin, page }) => {
  await addin.mockApiError("GET", "**/user/api-keys", 500, "Key status unavailable");
  await addin.mockApiJson("GET", "**/user/profile", {
    lastSelectedChatModel: "openrouter/openai/personal-choice",
    openRouterModels: ["openai/personal-choice"],
  });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();

  const modelPicker = page.getByRole("button", { name: "Choose model" });
  await expect(modelPicker).toHaveAttribute("title", /Personal Choice/);
  await modelPicker.click();
  await expect(page.getByRole("menuitem", { name: /Personal Choice/ })).toBeVisible();
});

test("the caller's own keys do not offer models an organization cannot run", async ({
  addin,
  page,
}) => {
  // The default personal status has Gemini; the organization has no key.
  await mockOrgs(page, [[FIRM]]);
  await recordHistory(page, () => ({ status: 200, body: [] }));
  await mockOrgKeys(page, NO_KEYS);
  let posted = false;
  await page.route("**/word-chat", (route, request) => {
    if (request.method() === "POST") posted = true;
    return route.fallback();
  });
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await expect(page.getByText(/No AI provider key is set up/)).toHaveCount(0);

  await chooseWorkspace(page, "Firm LLP");
  await expect(
    page.getByText("No AI provider key is set up for this organization."),
  ).toBeVisible();
  // A member cannot change the organization's keys, so is not sent to.
  await expect(page.getByText(/until an owner or admin of the organization adds one/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up API keys" })).toHaveCount(0);
  await expect(page.getByText("No Models").first()).toBeVisible();

  await page.getByPlaceholder("How can I help?").fill("Review the indemnity");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Select a model before sending your message/)).toBeVisible();
  expect(posted).toBe(false);
});

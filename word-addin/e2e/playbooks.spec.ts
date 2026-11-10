/**
 * E2E coverage for attaching a playbook to the Word chat, the add-in's
 * version of the web composer's "Use in assistant".
 *
 *   "+" -> Playbooks -> GET /playbooks?workspace=personal -> Use
 *     -> a pill in the composer
 *     -> Send carries `playbook: { id, title }` on the user message
 *     -> the sent message shows the same pill, and a stored chat does too
 *
 * All network is mocked via the shared fixture; no live backend is contacted.
 */
import { test, expect } from "./support/fixtures";

const TOKEN = "playbook-test-token";

const NDA = {
  id: "5d0c1c7e-8f0e-4c55-9a43-3c1d2f9f6b10",
  name: "NDA review",
  description: "Mutual NDAs for the buyer",
  content: { documentTypes: ["NDA"] },
};

const PLAYBOOKS = [
  NDA,
  {
    id: "8a7c3f0e-2b8d-4e8f-9c1a-6d5e4f3a2b10",
    name: "",
    description: "",
    content: { documentTypes: [] },
  },
];

test("attaches a playbook from the plus menu, sends it, and shows it on the message", async ({
  addin,
  page,
}) => {
  addin.seedToken(TOKEN);
  const listRequests: string[] = [];
  await page.route("**/playbooks?*", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    listRequests.push(request.url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PLAYBOOKS),
    });
  });
  await addin.mockChatStream(["One clause needs attention."]);
  await addin.gotoTaskpane({ documentText: "Confidential Information means…" });
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Add documents" }).click();
  await page.getByRole("menuitem", { name: "Playbooks" }).click();
  const modal = page.getByRole("dialog", { name: "Add playbook" });
  await expect(modal).toBeVisible();
  await expect.poll(() => listRequests.length).toBe(1);
  expect(new URL(listRequests[0] ?? "").searchParams.get("workspace")).toBe(
    "personal",
  );
  await expect(
    modal.getByRole("button", { name: "Untitled playbook" }),
  ).toBeVisible();
  const nda = modal.getByRole("button", { name: /NDA review/ });
  await expect(nda).toContainText("NDA");
  await expect(modal.getByRole("button", { name: "Use" })).toBeDisabled();
  await nda.click();
  await expect(nda).toHaveAttribute("aria-pressed", "true");
  await modal.getByRole("button", { name: "Use" }).click();
  await expect(modal).toHaveCount(0);

  const composer = page.getByTestId("chat-input");
  const remove = composer.getByRole("button", {
    name: "Remove playbook NDA review",
  });
  await expect(remove).toBeVisible();
  await expect(remove).toHaveAttribute("type", "button");
  await expect(
    composer.getByRole("button", { name: "Open playbook NDA review" }),
  ).toBeVisible();

  await page.getByPlaceholder("How can I help?").fill("Review this NDA");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();
  const message = body.messages[body.messages.length - 1];
  expect(message.role).toBe("user");
  expect(message.playbook).toEqual({
    id: NDA.id,
    title: "NDA review",
  });

  // The attachment belongs to the message now, not the composer.
  await expect(composer.getByText("NDA review")).toHaveCount(0);
  await expect(page.getByText("One clause needs attention.")).toBeVisible();
  await expect(page.getByText("NDA review", { exact: true })).toBeVisible();
});

test("removing the pill sends the message without a playbook", async ({
  addin,
  page,
}) => {
  addin.seedToken(TOKEN);
  await addin.mockApiJson("GET", "**/playbooks**", PLAYBOOKS);
  await addin.mockChatStream(["Done."]);
  await addin.gotoTaskpane({ documentText: "Confidential Information means…" });
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Add documents" }).click();
  await page.getByRole("menuitem", { name: "Playbooks" }).click();
  const modal = page.getByRole("dialog", { name: "Add playbook" });
  await modal.getByRole("button", { name: /NDA review/ }).click();
  await modal.getByRole("button", { name: "Use" }).click();
  await page
    .getByTestId("chat-input")
    .getByRole("button", { name: "Remove playbook NDA review" })
    .click();

  await page.getByPlaceholder("How can I help?").fill("Just summarise it");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();
  expect(body.messages[body.messages.length - 1].playbook).toBeUndefined();
});

test("a stored chat shows the playbook on its user message", async ({
  addin,
  page,
}) => {
  addin.seedToken(TOKEN);
  const chat = {
    id: "chat-1",
    project_id: null,
    user_id: "user-1",
    title: "NDA review chat",
    created_at: new Date().toISOString(),
  };
  await page.route("**/word-chat?*", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    if (!new URL(request.url()).searchParams.has("document_id"))
      return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([chat]),
    });
  });
  await page.route("**/word-chat/chat-1?*", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        chat,
        messages: [
          {
            id: "stored-user",
            role: "user",
            content: "Review this NDA",
            playbook: { id: NDA.id, title: "NDA review" },
          },
        ],
      }),
    });
  });
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await page.getByRole("button", { name: "Chat history" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: /NDA review chat/ })
    .click();
  await expect(page.getByText("Review this NDA")).toBeVisible();
  await expect(page.getByText("NDA review", { exact: true })).toBeVisible();
});

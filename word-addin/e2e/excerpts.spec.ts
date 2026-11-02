/**
 * E2E coverage for quoting a passage of an assistant response back into the
 * composer: the selection menu, the note bubble, the excerpt pills in the
 * composer and in the sent message, and the quoted text that reaches the
 * `/word-chat` request. The UI is the web app's, shared through
 * frontend/src/shared/ui.
 */
import { expect, test } from "./support/fixtures";
import type { Page, Request } from "@playwright/test";

const TOKEN = "excerpts-token";
const ANSWER = "The notice period is thirty days.";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

/** Sends a first message and highlights the whole answer, as a reader would. */
async function highlightAnswer(page: Page): Promise<void> {
  await page.getByPlaceholder("How can I help?").fill("What is the notice?");
  await page.getByRole("button", { name: "Send" }).click();
  const answer = page.getByText(ANSWER);
  await expect(answer).toBeVisible();
  await answer.click({ clickCount: 3 });
  await expect(page.getByRole("menu")).toBeVisible();
  // WebKit drops the selection when focus moves into the menu; the passage
  // has to stay marked while its menu is open.
  await expect.poll(() => markedPassage(page)).toBe(ANSWER);
}

/** The text of the passage the menu or note is currently marking. */
function markedPassage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const registry = (
      CSS as unknown as { highlights: Map<string, Iterable<Range>> }
    ).highlights;
    return [...(registry.get("response-excerpt") ?? [])]
      .map((range) => range.toString().trim())
      .join("");
  });
}

function nextChatRequest(page: Page): Promise<Request> {
  return page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().includes("/word-chat"),
  );
}

function lastUserContent(request: Request): string {
  const body = request.postDataJSON() as {
    messages: Array<{ role: string; content: string }>;
  };
  return body.messages.filter((message) => message.role === "user").at(-1)!
    .content;
}

test("quotes a highlighted passage with a note and sends it on its own", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([ANSWER]);
  await addin.gotoTaskpane({ documentText: "A document." });
  await addin.expectAuthedShell();
  await highlightAnswer(page);

  await expect(page.getByRole("menuitem")).toHaveText([
    "Copy",
    "Ask",
    "Annotate and ask",
  ]);
  await page.getByRole("menuitem", { name: "Annotate and ask" }).click();
  const note = page.getByRole("textbox", {
    name: "Note about the selected text",
  });
  await expect(note).toBeFocused();
  await note.fill("Is that enforceable?");
  await note.press("Enter");
  // Nothing stays highlighted once the passage has been taken.
  await expect.poll(() => markedPassage(page)).toBe("");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");

  // The composer names the excerpt; the passage is one click away.
  const pill = page.getByRole("button", { name: `View excerpt: ${ANSWER}` });
  await expect(pill).toHaveText("Annotated Excerpt");
  await pill.click();
  const dialog = page.getByRole("dialog", { name: "Annotated Excerpt" });
  await expect(dialog).toContainText(ANSWER);
  await expect(dialog).toContainText("Is that enforceable?");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // An annotated excerpt is a complete question: no typed text needed.
  const request = nextChatRequest(page);
  await page.getByRole("button", { name: "Send" }).click();
  expect(lastUserContent(await request)).toBe(
    `> ${ANSWER}\nNote: Is that enforceable?`,
  );

  // The sent message shows the pill, not the raw quote.
  await expect(
    page.getByRole("button", { name: `View excerpt: ${ANSWER}` }),
  ).toHaveText("Annotated Excerpt");
  await expect(page.getByText(/^> /)).toHaveCount(0);
});

test("dismissing the note leaves nothing highlighted", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([ANSWER]);
  await addin.gotoTaskpane({ documentText: "A document." });
  await addin.expectAuthedShell();
  await highlightAnswer(page);

  await page.getByRole("menuitem", { name: "Annotate and ask" }).click();
  const note = page.getByRole("textbox", {
    name: "Note about the selected text",
  });
  await note.fill("Never sent");
  await expect.poll(() => markedPassage(page)).toBe(ANSWER);

  // Click away without submitting.
  await page.getByTestId("chat-input").click({ position: { x: 5, y: 5 } });
  await expect(note).toBeHidden();
  await expect.poll(() => markedPassage(page)).toBe("");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await expect(page.getByRole("button", { name: /View excerpt/ })).toHaveCount(0);
});

test("adds a plain excerpt on Ask and sends it above the typed question", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([ANSWER]);
  await addin.gotoTaskpane({ documentText: "A document." });
  await addin.expectAuthedShell();
  await highlightAnswer(page);

  await page.getByRole("menuitem", { name: "Ask", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `View excerpt: ${ANSWER}` }),
  ).toHaveText("Excerpt");
  // A bare excerpt asks nothing yet.
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await page.getByPlaceholder("How can I help?").fill("Is that standard?");
  const request = nextChatRequest(page);
  await page.getByRole("button", { name: "Send" }).click();
  expect(lastUserContent(await request)).toBe(
    `> ${ANSWER}\n\nIs that standard?`,
  );
});

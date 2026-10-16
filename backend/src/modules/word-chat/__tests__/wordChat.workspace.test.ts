import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { prepareWordChatStream } from "../wordChat.service";

const prepare = (
  db: Parameters<typeof prepareWordChatStream>[0],
  overrides: Partial<Parameters<typeof prepareWordChatStream>[1]>,
) =>
  prepareWordChatStream(db, {
    userId: "u", userEmail: "u@example.com", chatId: null,
    messages: [{ role: "user", content: "Read this", files: [{ document_id: "doc", filename: "file.pdf" }] }],
    clientDocumentId: "word-document", activeDocumentName: "Draft", documentContext: undefined,
    persistChat: true, clientToolsEnabled: false, requestedModel: null, requestedReasoning: undefined,
    ...overrides,
  });

describe("Word chat preparation workspace", () => {
  it.each([false, true])("keeps an organization's document out of a Personal chat, before model selection or persistence (cloud=%s)", async persistChat => {
    const fake = scriptedDb([
      { table: "documents", data: [{ id: "doc", org_id: "firm" }] },
      { table: "organizations", data: [{ id: "firm", kind: "team" }] },
    ]);
    const result = await prepare(fake.db, { persistChat });
    expect(result).toMatchObject({ ok: false, status: 400, code: "document_workspace_mismatch" });
    fake.done();
  });

  it("keeps a Personal document out of an organization's chat", async () => {
    const fake = scriptedDb([
      // resolveStandaloneOrgId: a member, of a team organization.
      { table: "org_members", data: { role: "member" } },
      { table: "organizations", data: { kind: "team" } },
      { table: "documents", data: [{ id: "doc", org_id: null }] },
      { table: "organizations", data: [{ id: "firm", kind: "team" }] },
    ]);
    const result = await prepare(fake.db, { requestedOrgId: "firm" });
    expect(result).toMatchObject({ ok: false, status: 400, code: "document_workspace_mismatch" });
    fake.done();
  });

  it("will not continue a Personal chat whose stored history holds an organization's document", async () => {
    const fake = scriptedDb([
      { table: "word_documents", data: { id: "row" } },
      { table: "word_chats", data: { id: "chat", user_id: "u", org_id: null } },
      { table: "word_chat_messages", data: [{ files: [{ document_id: "old" }] }] },
      { table: "documents", data: [{ id: "old", org_id: "firm" }] },
      { table: "organizations", data: [{ id: "firm", kind: "team" }] },
    ]);
    const result = await prepare(fake.db, {
      chatId: "chat",
      messages: [{ role: "user", content: "Continue" }],
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: "document_workspace_mismatch" });
    fake.done();
  });
});

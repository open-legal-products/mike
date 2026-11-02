import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { prepareWordChatStream } from "../wordChat.service";

describe("Word chat preparation workspace", () => {
  it.each([false, true])("rejects organization attachments before model selection or persistence (cloud=%s)", async persistChat => {
    const fake = scriptedDb([
      { table: "documents", data: [{ id: "doc", org_id: "firm" }] },
      { table: "organizations", data: [{ id: "firm", kind: "team" }] },
    ]);
    const result = await prepareWordChatStream(fake.db, {
      userId: "u", userEmail: "u@example.com", chatId: null,
      messages: [{ role: "user", content: "Read this", files: [{ document_id: "doc", filename: "secret.pdf" }] }],
      clientDocumentId: "word-document", activeDocumentName: "Draft", documentContext: undefined,
      persistChat, clientToolsEnabled: false, requestedModel: null, requestedReasoning: undefined,
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: "document_workspace_mismatch" });
    fake.done();
  });
});

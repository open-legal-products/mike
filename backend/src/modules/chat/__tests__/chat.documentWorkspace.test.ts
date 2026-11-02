import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { prepareChatStream } from "../chat.prepare";

// A chat is built from documents in its own workspace. The refusal comes
// before anything is written: the scripts below hold no insert, so a chat
// row or a stored message would fail them as an unexpected query.

const turn = (documentId: string) => ({
    userId: "u1",
    userEmail: "u1@example.com",
    messages: [
        {
            role: "user" as const,
            content: "Summarise this",
            files: [{ filename: "file.pdf", document_id: documentId }],
        },
    ],
    chatId: null,
    inputMessageId: null,
    projectIdProvided: false,
    projectId: null,
    askInputsResponse: null,
    requestedModel: undefined,
    requestedReasoning: undefined,
});

const REFUSAL = {
    ok: false,
    status: 400,
    code: "document_workspace_mismatch",
};

describe("prepareChatStream and documents from another workspace", () => {
    it("refuses a personal document in a chat started in an organization", async () => {
        const fake = scriptedDb([
            // Starting the chat in the organization: the caller is a member.
            { table: "org_members", data: { role: "member" } },
            { table: "organizations", data: { kind: "team" } },
            // Where the attachment is filed.
            {
                table: "documents",
                data: [
                    {
                        id: "mine",
                        project_id: null,
                        workflow_id: null,
                        org_id: null,
                    },
                ],
            },
            { table: "organizations", data: [{ id: "org-1", kind: "team" }] },
        ]);
        await expect(
            prepareChatStream(fake.db, {
                ...turn("mine"),
                requestedOrgId: "org-1",
            }),
        ).resolves.toMatchObject(REFUSAL);
        fake.done();
    });

    it("refuses an organization's document in a personal chat", async () => {
        const fake = scriptedDb([
            {
                table: "documents",
                data: [
                    {
                        id: "firm-file",
                        project_id: null,
                        workflow_id: null,
                        org_id: "org-1",
                    },
                ],
            },
            { table: "organizations", data: [{ id: "org-1", kind: "team" }] },
        ]);
        await expect(
            prepareChatStream(fake.db, turn("firm-file")),
        ).resolves.toMatchObject(REFUSAL);
        fake.done();
    });
});

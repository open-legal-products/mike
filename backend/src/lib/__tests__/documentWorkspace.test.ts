import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../__tests__/helpers/scriptedDb";
import {
    findDocumentsOutsideWorkspace,
    findNewAttachmentsOutsideWorkspace,
} from "../documentWorkspace";

const FIRM = "firm";
const OTHER_FIRM = "other-firm";
const MINE = "my-personal-org";

const organizations = {
    table: "organizations",
    data: [
        { id: FIRM, kind: "team" },
        { id: OTHER_FIRM, kind: "team" },
        { id: MINE, kind: "personal" },
    ],
};

function doc(
    id: string,
    placement: {
        project_id?: string | null;
        workflow_id?: string | null;
        org_id?: string | null;
    },
) {
    return { id, project_id: null, workflow_id: null, org_id: null, ...placement };
}

describe("findDocumentsOutsideWorkspace", () => {
    it("asks nothing when no document is named", async () => {
        const fake = scriptedDb([]);
        expect(await findDocumentsOutsideWorkspace(fake.db, [], FIRM)).toEqual(
            [],
        );
        fake.done();
    });

    it("keeps an organization's documents out of Personal, and personal ones out of an organization", async () => {
        const documents = {
            table: "documents",
            data: [
                doc("firm-file", { org_id: FIRM }),
                doc("personal-file", {}),
                doc("my-org-file", { org_id: MINE }),
            ],
        };
        const ids = ["firm-file", "personal-file", "my-org-file"];

        const inFirm = scriptedDb([documents, organizations]);
        expect(
            await findDocumentsOutsideWorkspace(inFirm.db, ids, FIRM),
        ).toEqual(["personal-file", "my-org-file"]);
        inFirm.done();

        // A person's own organization is Personal, however it is named: no
        // organization at all, or theirs.
        for (const personal of [null, MINE]) {
            const inPersonal = scriptedDb([documents, organizations]);
            expect(
                await findDocumentsOutsideWorkspace(
                    inPersonal.db,
                    ids,
                    personal,
                ),
            ).toEqual(["firm-file"]);
            inPersonal.done();
        }
    });

    it("keeps one organization's documents out of another", async () => {
        const fake = scriptedDb([
            { table: "documents", data: [doc("firm-file", { org_id: FIRM })] },
            organizations,
        ]);
        expect(
            await findDocumentsOutsideWorkspace(
                fake.db,
                ["firm-file"],
                OTHER_FIRM,
            ),
        ).toEqual(["firm-file"]);
        fake.done();
    });

    it("places a project document by its project, not by its own column", async () => {
        const fake = scriptedDb([
            {
                table: "documents",
                data: [
                    // Stamped with nothing, but filed in the firm's matter.
                    doc("matter-file", { project_id: "matter" }),
                    // Stamped with the firm, but filed in a personal project.
                    doc("stale-file", { project_id: "mine", org_id: FIRM }),
                ],
            },
            {
                table: "projects",
                data: [
                    { id: "matter", org_id: FIRM },
                    { id: "mine", org_id: null },
                ],
            },
            organizations,
        ]);
        expect(
            await findDocumentsOutsideWorkspace(
                fake.db,
                ["matter-file", "stale-file"],
                FIRM,
            ),
        ).toEqual(["stale-file"]);
        fake.done();
    });

    it("leaves a workflow's own files to the workflow", async () => {
        const fake = scriptedDb([
            {
                table: "documents",
                data: [doc("asset", { workflow_id: "wf", org_id: FIRM })],
            },
        ]);
        expect(
            await findDocumentsOutsideWorkspace(fake.db, ["asset"], null),
        ).toEqual([]);
        fake.done();
    });

    it("throws rather than wave documents through when it cannot read them", async () => {
        const fake = scriptedDb([
            { table: "documents", error: { message: "boom" } },
        ]);
        await expect(
            findDocumentsOutsideWorkspace(fake.db, ["firm-file"], null),
        ).rejects.toThrow("Failed to read the documents' workspaces");
    });
});

describe("findNewAttachmentsOutsideWorkspace", () => {
    const firmFile = { filename: "firm.pdf", document_id: "firm-file" };

    it("asks nothing when the turn carries no attachment", async () => {
        const fake = scriptedDb([]);
        expect(
            await findNewAttachmentsOutsideWorkspace(fake.db, {
                messages: [{ files: null }, {}],
                chatId: "chat",
                orgId: null,
            }),
        ).toEqual([]);
        fake.done();
    });

    it("looks at every message the client sent, not only the last", async () => {
        const fake = scriptedDb([
            { table: "documents", data: [doc("firm-file", { org_id: FIRM })] },
            organizations,
        ]);
        expect(
            await findNewAttachmentsOutsideWorkspace(fake.db, {
                messages: [{ files: [firmFile] }, { files: [] }],
                chatId: null,
                orgId: null,
            }),
        ).toEqual(["firm-file"]);
        fake.done();
    });

    it("lets through what the stored conversation already has attached", async () => {
        const fake = scriptedDb([
            { table: "chat_messages", data: [{ files: [firmFile] }] },
        ]);
        expect(
            await findNewAttachmentsOutsideWorkspace(fake.db, {
                messages: [{ files: [firmFile] }, { files: [] }],
                chatId: "chat",
                orgId: null,
            }),
        ).toEqual([]);
        // Only this chat's own user messages were read.
        expect(fake.calls[0].filters).toEqual([
            ["eq", "chat_id", "chat"],
            ["eq", "role", "user"],
        ]);
        fake.done();
    });

    it("still refuses a new attachment in a chat that has older ones", async () => {
        const fake = scriptedDb([
            { table: "chat_messages", data: [{ files: [firmFile] }] },
            {
                table: "documents",
                data: [doc("other-file", { org_id: OTHER_FIRM })],
            },
            organizations,
        ]);
        expect(
            await findNewAttachmentsOutsideWorkspace(fake.db, {
                messages: [
                    { files: [firmFile] },
                    {
                        files: [
                            { filename: "o.pdf", document_id: "other-file" },
                        ],
                    },
                ],
                chatId: "chat",
                orgId: FIRM,
            }),
        ).toEqual(["other-file"]);
        fake.done();
    });
});

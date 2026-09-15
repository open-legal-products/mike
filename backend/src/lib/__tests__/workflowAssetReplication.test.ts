import { beforeEach, describe, expect, it, vi } from "vitest";

const { downloadFile, uploadFile } = vi.hoisted(() => ({
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
}));

vi.mock("../storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../storage")>();
    return {
        ...actual,
        downloadFile: (...args: unknown[]) => downloadFile(...args),
        uploadFile: (...args: unknown[]) => uploadFile(...args),
    };
});

vi.mock("../downloadTokens", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../downloadTokens")>();
    return {
        ...actual,
        buildDownloadUrl: (_storagePath: string, filename: string) =>
            `/download/${encodeURIComponent(filename)}`,
    };
});

import { runToolCalls } from "../../modules/chat/engine/tools/toolDispatcher";
import { PROJECT_EXTRA_TOOLS, TOOLS } from "../../modules/chat/engine/tools/toolSchemas";
import type { DocIndex, DocStore, WorkflowStore } from "../../modules/chat/engine/types";

function toolNames(tools: readonly { function: { name: string } }[]) {
    return tools.map((tool) => tool.function.name);
}

function replicationDb(callOrder: string[] = []) {
    const documentRows: Record<string, unknown>[][] = [];
    const versionRows: Record<string, unknown>[][] = [];
    const db = {
        rpc: vi.fn(async (name: string, args: { p_versions: Record<string, unknown>[] }) => {
            expect(name).toBe("create_document_versions");
            callOrder.push("insert:document_versions");
            versionRows.push(args.p_versions);
            return { data: args.p_versions.map((row, index) => ({ ...row, id: `new-version-${index + 1}` })), error: null };
        }),
        from(table: string) {
            if (table === "documents") {
                return {
                    insert(rows: Record<string, unknown>[]) {
                        callOrder.push("insert:documents");
                        documentRows.push(rows);
                        return {
                            // Documents rows carry client-generated ids;
                            // echo them back like Postgres would.
                            select: async () => ({
                                data: rows.map((row) => ({ id: row.id })),
                                error: null,
                            }),
                        };
                    },
                    update: () => ({
                        eq: async () => ({ data: null, error: null }),
                    }),
                    delete: () => ({
                        in: async () => ({ data: null, error: null }),
                    }),
                };
            }
            if (table === "document_versions") {
                return {
                    insert(rows: Record<string, unknown>[]) {
                        callOrder.push("insert:document_versions");
                        versionRows.push(rows);
                        return {
                            select: async () => ({
                                data: rows.map((row, index) => ({
                                    id: `new-version-${index + 1}`,
                                    document_id: row.document_id,
                                })),
                                error: null,
                            }),
                        };
                    },
                };
            }
            throw new Error(`Unexpected table: ${table}`);
        },
    };
    return { db, documentRows, versionRows };
}

describe("replicate_document availability", () => {
    it("is a base assistant tool rather than a project-only tool", () => {
        expect(toolNames(TOOLS)).toContain("replicate_document");
        expect(toolNames(PROJECT_EXTRA_TOOLS)).not.toContain("replicate_document");
    });
});

describe("workflow asset replication", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        downloadFile.mockResolvedValue(new TextEncoder().encode("asset").buffer);
        uploadFile.mockResolvedValue(undefined);
    });

    it("exposes workflow assets as immutable document handles", async () => {
        const store: DocStore = new Map();
        const workflows: WorkflowStore = new Map([
            [
                "workflow-12345678",
                {
                    title: "Draft from precedent",
                    skill_md: "Use the precedent.",
                    assets: [
                        {
                            asset_id: "asset-1",
                            filename: "Precedent.docx",
                            file_type: "docx",
                            storage_path: "workflow-assets/precedent.docx",
                        },
                    ],
                },
            ],
        ]);

        const result = await runToolCalls(
            [
                {
                    id: "read-workflow",
                    function: {
                        name: "read_workflow",
                        arguments: JSON.stringify({
                            workflow_id: "workflow-12345678",
                        }),
                    },
                },
            ],
            store,
            "user-1",
            {} as never,
            () => undefined,
            workflows,
            undefined,
            {},
        );

        // Handle keys embed the FULL workflow id: builtin-* ids all share
        // an 8-character prefix, so a truncated id would collide.
        expect(store.get("workflow-asset-workflow-12345678-1")).toMatchObject({
            filename: "Precedent.docx",
            source_kind: "workflow_asset",
        });
        expect(
            (result.toolResults[0] as { content: string }).content,
        ).toContain("Available immutable workflow assets");
    });

    it("copies an asset into Library Files and registers the copy for editing", async () => {
        const sourceLabel = "workflow-asset-workflow-1-1";
        const sourceBytes = new TextEncoder().encode("asset").buffer;
        downloadFile.mockResolvedValue(sourceBytes);
        const store: DocStore = new Map([
            [
                sourceLabel,
                {
                    filename: "Precedent.pdf",
                    file_type: "pdf",
                    storage_path: "workflow-assets/precedent.pdf",
                    source_kind: "workflow_asset",
                },
            ],
        ]);
        const index: DocIndex = {};
        const callOrder: string[] = [];
        uploadFile.mockImplementation((key: unknown) => {
            callOrder.push(`upload:${String(key)}`);
            return Promise.resolve(undefined);
        });
        const { db, documentRows, versionRows } = replicationDb(callOrder);

        const result = await runToolCalls(
            [
                {
                    id: "replicate-asset",
                    function: {
                        name: "replicate_document",
                        arguments: JSON.stringify({
                            doc_id: sourceLabel,
                            new_filename: "Client precedent.pdf",
                        }),
                    },
                },
            ],
            store,
            "user-1",
            db as never,
            () => undefined,
            undefined,
            undefined,
            index,
        );

        expect(documentRows[0]).toEqual([
            expect.objectContaining({
                id: expect.any(String),
                project_id: null,
                user_id: "user-1",
                library_kind: "file",
                library_folder_id: null,
            }),
        ]);
        const documentId = documentRows[0][0].id as string;

        // The copy's bytes are uploaded to the id-derived storage key
        // BEFORE any documents row is inserted, so a failed upload can
        // never leave a "ready" library row without content.
        const expectedKey = `documents/user-1/${documentId}/source.pdf`;
        expect(uploadFile).toHaveBeenCalledWith(
            expectedKey,
            sourceBytes,
            "application/pdf",
        );
        const insertPosition = callOrder.indexOf("insert:documents");
        const uploadPositions = callOrder
            .map((entry, position) => ({ entry, position }))
            .filter(({ entry }) => entry.startsWith("upload:"))
            .map(({ position }) => position);
        expect(uploadPositions.length).toBeGreaterThan(0);
        expect(Math.max(...uploadPositions)).toBeLessThan(insertPosition);

        expect(versionRows[0][0]).toMatchObject({
            document_id: documentId,
            storage_path: expectedKey,
            filename: "Client precedent.pdf",
            file_type: "pdf",
            source: "upload",
        });
        expect(index["doc-0"]).toMatchObject({
            document_id: documentId,
            filename: "Client precedent.pdf",
        });
        expect(store.get("doc-0")?.source_kind).toBe("document");
        const toolResult = result.toolResults[0] as { content: string };
        expect(JSON.parse(toolResult.content)).toMatchObject({
            ok: true,
            saved_to: "library_files",
        });
    });

    it("creates no documents row and reports a generic failure when the upload fails", async () => {
        const sourceLabel = "workflow-ref-workflow-1-1";
        const store: DocStore = new Map([
            [
                sourceLabel,
                {
                    filename: "Precedent.pdf",
                    file_type: "pdf",
                    storage_path: "workflow-assets/precedent.pdf",
                    source_kind: "workflow_asset",
                },
            ],
        ]);
        uploadFile.mockRejectedValue(new Error("bucket unavailable"));
        const { db, documentRows, versionRows } = replicationDb();

        const result = await runToolCalls(
            [
                {
                    id: "replicate-upload-failure",
                    function: {
                        name: "replicate_document",
                        arguments: JSON.stringify({
                            doc_id: sourceLabel,
                            new_filename: "Client precedent.pdf",
                        }),
                    },
                },
            ],
            store,
            "user-1",
            db as never,
            () => undefined,
            undefined,
            undefined,
            {},
        );

        expect(documentRows).toHaveLength(0);
        expect(versionRows).toHaveLength(0);
        const toolResult = result.toolResults[0] as { content: string };
        const payload = JSON.parse(toolResult.content);
        expect(payload.ok).toBe(false);
        expect(payload.error).toBe("replicate_document failed");
    });

    it("saves the same copy to Project Documents in a project chat", async () => {
        const sourceLabel = "workflow-ref-1";
        const store: DocStore = new Map([
            [
                sourceLabel,
                {
                    filename: "Precedent.pdf",
                    file_type: "pdf",
                    storage_path: "workflow-assets/precedent.pdf",
                    source_kind: "workflow_asset",
                },
            ],
        ]);
        const { db, documentRows } = replicationDb();

        const result = await runToolCalls(
            [
                {
                    id: "replicate-project-asset",
                    function: {
                        name: "replicate_document",
                        arguments: JSON.stringify({
                            doc_id: sourceLabel,
                            new_filename: "Project precedent.pdf",
                        }),
                    },
                },
            ],
            store,
            "user-1",
            db as never,
            () => undefined,
            undefined,
            undefined,
            {},
            undefined,
            undefined,
            "project-1",
        );

        expect(documentRows[0][0]).toMatchObject({
            project_id: "project-1",
            library_kind: "file",
        });
        const toolResult = result.toolResults[0] as { content: string };
        expect(JSON.parse(toolResult.content)).toMatchObject({
            ok: true,
            saved_to: "project_documents",
        });
    });

    it("requires a new name before copying immutable source material", async () => {
        const sourceLabel = "workflow-ref-1";
        const store: DocStore = new Map([
            [
                sourceLabel,
                {
                    filename: "Template.docx",
                    file_type: "docx",
                    storage_path: "workflow-assets/template.docx",
                    source_kind: "workflow_asset",
                },
            ],
        ]);

        const result = await runToolCalls(
            [
                {
                    id: "replicate-without-name",
                    function: {
                        name: "replicate_document",
                        arguments: JSON.stringify({ doc_id: sourceLabel }),
                    },
                },
            ],
            store,
            "user-1",
            {} as never,
            () => undefined,
            undefined,
            undefined,
            {},
        );

        expect(JSON.stringify(result.toolResults)).toContain("A new_filename is required");
        expect(downloadFile).not.toHaveBeenCalled();
    });

    it("refuses to edit a Library Template directly", async () => {
        const store: DocStore = new Map([
            [
                "doc-0",
                {
                    filename: "Template.docx",
                    file_type: "docx",
                    storage_path: "documents/template.docx",
                    source_kind: "library_template",
                },
            ],
        ]);

        const result = await runToolCalls(
            [
                {
                    id: "edit-template",
                    function: {
                        name: "edit_document",
                        arguments: JSON.stringify({
                            doc_id: "doc-0",
                            edits: [{ find: "A", replace: "B" }],
                        }),
                    },
                },
            ],
            store,
            "user-1",
            {} as never,
            () => undefined,
            undefined,
            undefined,
            {
                "doc-0": {
                    document_id: "template-document",
                    filename: "Template.docx",
                },
            },
        );

        expect(JSON.stringify(result.toolResults)).toContain("cannot be edited directly");
    });
});

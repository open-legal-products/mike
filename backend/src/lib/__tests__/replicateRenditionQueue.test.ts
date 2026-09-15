import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// replicate_document is a chat-tool LibreOffice call site: when the copied
// source has no PDF rendition, the sync path converts inline on the request
// thread. These tests pin the ASYNC_DOCUMENT_CONVERSION contract there:
//   - flag off → inline docxToPdf, one shared rendition uploaded per copy,
//     no queue involved (the historical behavior)
//   - flag on  → no LibreOffice in-band; copies are inserted without a
//     rendition and one conversion job per copy fills it in

const { downloadFile, uploadFile, docxToPdf, enqueueConversion } = vi.hoisted(
    () => ({
        downloadFile: vi.fn(),
        uploadFile: vi.fn(),
        docxToPdf: vi.fn(),
        enqueueConversion: vi.fn(),
    }),
);

vi.mock("../storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../storage")>();
    return {
        ...actual,
        downloadFile: (...args: unknown[]) => downloadFile(...args),
        uploadFile: (...args: unknown[]) => uploadFile(...args),
    };
});

vi.mock("../convert", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../convert")>();
    return {
        ...actual,
        docxToPdf: (...args: unknown[]) => docxToPdf(...args),
    };
});

vi.mock("../queue/conversionQueue", () => ({
    enqueueConversion: (...args: unknown[]) => enqueueConversion(...args),
}));

vi.mock("../downloadTokens", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../downloadTokens")>();
    return {
        ...actual,
        buildDownloadUrl: (_storagePath: string, filename: string) =>
            `/download/${encodeURIComponent(filename)}`,
    };
});

import { runToolCalls } from "../../modules/chat/engine/tools/toolDispatcher";
import type { DocIndex, DocStore } from "../../modules/chat/engine/types";

// Same double as workflowAssetReplication.test.ts: documents echo their
// client-generated ids; versions get deterministic new-version-N ids.
function replicationDb() {
    const versionRows: Record<string, unknown>[][] = [];
    const db = {
        rpc: vi.fn(async (name: string, args: { p_versions: Record<string, unknown>[] }) => {
            expect(name).toBe("create_document_versions");
            versionRows.push(args.p_versions);
            return { data: args.p_versions.map((row, index) => ({ ...row, id: `new-version-${index + 1}` })), error: null };
        }),
        from(table: string) {
            if (table === "documents") {
                return {
                    insert(rows: Record<string, unknown>[]) {
                        return {
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
    return { db, versionRows };
}

// A DOCX workflow asset with no rendition — the exact case that pays for
// LibreOffice inside replicate_document.
const SOURCE_LABEL = "workflow-ref-workflow-1-1";
function makeStore(): DocStore {
    return new Map([
        [
            SOURCE_LABEL,
            {
                filename: "Precedent.docx",
                file_type: "docx",
                storage_path: "workflow-assets/precedent.docx",
                source_kind: "workflow_asset" as const,
            },
        ],
    ]);
}

async function replicate(db: unknown, index: DocIndex, count?: number) {
    return runToolCalls(
        [
            {
                id: "replicate-1",
                function: {
                    name: "replicate_document",
                    arguments: JSON.stringify({
                        doc_id: SOURCE_LABEL,
                        new_filename: "Client precedent.docx",
                        ...(count ? { count } : {}),
                    }),
                },
            },
        ],
        makeStore(),
        "user-1",
        db as never,
        () => undefined,
        undefined,
        undefined,
        index,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    downloadFile.mockResolvedValue(new TextEncoder().encode("docx").buffer);
    uploadFile.mockResolvedValue(undefined);
    docxToPdf.mockResolvedValue(Buffer.from("pdf-bytes"));
    enqueueConversion.mockResolvedValue({});
});

afterEach(() => {
    delete process.env.ASYNC_DOCUMENT_CONVERSION;
});

describe("replicate_document rendition path", () => {
    it("flag off: converts inline once and stores a rendition per copy", async () => {
        process.env.ASYNC_DOCUMENT_CONVERSION = "false";
        const { db, versionRows } = replicationDb();

        await replicate(db, {});

        expect(docxToPdf).toHaveBeenCalledTimes(1);
        expect(enqueueConversion).not.toHaveBeenCalled();
        expect(versionRows[0][0].pdf_storage_path).toMatch(/^converted-pdfs\//);
    });

    it("flag on: no in-band LibreOffice; one conversion job per copy", async () => {
        process.env.ASYNC_DOCUMENT_CONVERSION = "true";
        const { db, versionRows } = replicationDb();

        await replicate(db, {}, 2);

        expect(docxToPdf).not.toHaveBeenCalled();
        // Copies are inserted rendition-less; the queue fills them in.
        expect(versionRows[0].map((r) => r.pdf_storage_path)).toEqual([
            null,
            null,
        ]);
        expect(enqueueConversion).toHaveBeenCalledTimes(2);
        for (const [call, versionId] of [
            [enqueueConversion.mock.calls[0][0], "new-version-1"],
            [enqueueConversion.mock.calls[1][0], "new-version-2"],
        ] as [Record<string, unknown>, string][]) {
            expect(call).toMatchObject({
                versionId,
                userId: "user-1",
                fileType: "docx",
                // Copies are inserted "ready" and usable from raw bytes; a
                // rendition failure must never flip them to "error".
                finalizeDocumentStatus: false,
            });
            expect(call.pdfKey).toBe(
                `converted-pdfs/user-1/${call.documentId as string}.pdf`,
            );
        }
    });

    it("flag on: a failed enqueue still returns usable copies (no rendition)", async () => {
        process.env.ASYNC_DOCUMENT_CONVERSION = "true";
        enqueueConversion.mockRejectedValue(new Error("redis down"));
        const { db } = replicationDb();
        const index: DocIndex = {};

        const result = await replicate(db, index);

        const content = JSON.parse(
            (result.toolResults[0] as { content: string }).content,
        );
        expect(content.ok).toBe(true);
        expect(content.copies).toHaveLength(1);
        expect(index["doc-0"]).toBeDefined();
    });
});

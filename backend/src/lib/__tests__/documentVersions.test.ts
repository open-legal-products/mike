import { describe, it, expect } from "vitest";
import {
    contentSha256,
    loadActiveVersion,
    attachActiveVersionPaths,
    attachLatestVersionNumbers,
} from "../documentVersions";

type Row = Record<string, unknown>;

/**
 * Read-only Supabase mock covering the query chains documentVersions uses:
 * select/eq/in/is/not filters plus single() and awaiting the builder.
 */
function makeDb(tables: Record<string, Row[]>) {
    return {
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            const query: any = {
                select: () => query,
                eq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                in: (column: string, values: unknown[]) => {
                    rows = rows.filter((row) => values.includes(row[column]));
                    return query;
                },
                is: (column: string, value: unknown) => {
                    rows = rows.filter((row) => (row[column] ?? null) === value);
                    return query;
                },
                not: (column: string, operator: string, value: unknown) => {
                    if (operator === "is" && value === null) {
                        rows = rows.filter((row) => row[column] != null);
                    }
                    return query;
                },
                single: async () => ({ data: rows[0] ?? null, error: null }),
                then: (
                    resolve: (value: { data: Row[]; error: null }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
            };
            return query;
        },
    } as any;
}

/** Shape of the mutable doc rows the attach* helpers annotate in place. */
type TestDoc = {
    id: string;
    current_version_id?: string | null;
    latest_version_number?: number | null;
    [k: string]: unknown;
};

const FULL_VERSION = {
    id: "ver-1",
    document_id: "doc-1",
    storage_path: "documents/u/doc-1/source.pdf",
    pdf_storage_path: "documents/u/doc-1/converted.pdf",
    version_number: 3,
    filename: "contract.pdf",
    source: "upload",
    file_type: "application/pdf",
    size_bytes: 1024,
    page_count: 12,
    deleted_at: null,
};

// ---------------------------------------------------------------------------
// loadActiveVersion
// ---------------------------------------------------------------------------

describe("loadActiveVersion", () => {
    it("resolves the document's current version by default", async () => {
        const db = makeDb({
            documents: [{ id: "doc-1", current_version_id: "ver-1" }],
            document_versions: [FULL_VERSION],
        });
        await expect(loadActiveVersion("doc-1", db)).resolves.toEqual({
            id: "ver-1",
            storage_path: "documents/u/doc-1/source.pdf",
            pdf_storage_path: "documents/u/doc-1/converted.pdf",
            version_number: 3,
            filename: "contract.pdf",
            source: "upload",
            file_type: "application/pdf",
            size_bytes: 1024,
            page_count: 12,
        });
    });

    it("prefers an explicit versionId over current_version_id", async () => {
        const db = makeDb({
            documents: [{ id: "doc-1", current_version_id: "ver-1" }],
            document_versions: [
                FULL_VERSION,
                { ...FULL_VERSION, id: "ver-2", version_number: 2 },
            ],
        });
        const version = await loadActiveVersion("doc-1", db, "ver-2");
        expect(version?.id).toBe("ver-2");
        expect(version?.version_number).toBe(2);
    });

    it("returns null when neither versionId nor current_version_id exist", async () => {
        const db = makeDb({
            documents: [{ id: "doc-1", current_version_id: null }],
            document_versions: [FULL_VERSION],
        });
        await expect(loadActiveVersion("doc-1", db)).resolves.toBeNull();
    });

    it("returns null when the version belongs to a different document", async () => {
        const db = makeDb({
            documents: [{ id: "doc-1", current_version_id: "ver-other" }],
            document_versions: [
                { ...FULL_VERSION, id: "ver-other", document_id: "doc-2" },
            ],
        });
        await expect(loadActiveVersion("doc-1", db)).resolves.toBeNull();
        // Also guards against a spoofed explicit versionId.
        await expect(
            loadActiveVersion("doc-1", db, "ver-other"),
        ).resolves.toBeNull();
    });

    it("returns null for soft-deleted versions", async () => {
        const db = makeDb({
            documents: [{ id: "doc-1", current_version_id: "ver-1" }],
            document_versions: [
                { ...FULL_VERSION, deleted_at: "2026-01-01T00:00:00Z" },
            ],
        });
        await expect(loadActiveVersion("doc-1", db)).resolves.toBeNull();
    });

    it("returns null when the version has no storage_path", async () => {
        const db = makeDb({
            documents: [{ id: "doc-1", current_version_id: "ver-1" }],
            document_versions: [{ ...FULL_VERSION, storage_path: null }],
        });
        await expect(loadActiveVersion("doc-1", db)).resolves.toBeNull();
    });

    it("defaults optional metadata fields to null", async () => {
        const db = makeDb({
            documents: [{ id: "doc-1", current_version_id: "ver-1" }],
            document_versions: [
                {
                    id: "ver-1",
                    document_id: "doc-1",
                    storage_path: "documents/u/doc-1/source.docx",
                    deleted_at: null,
                },
            ],
        });
        await expect(loadActiveVersion("doc-1", db)).resolves.toEqual({
            id: "ver-1",
            storage_path: "documents/u/doc-1/source.docx",
            pdf_storage_path: null,
            version_number: null,
            filename: null,
            source: null,
            file_type: null,
            size_bytes: null,
            page_count: null,
        });
    });
});

// ---------------------------------------------------------------------------
// attachActiveVersionPaths
// ---------------------------------------------------------------------------

describe("attachActiveVersionPaths", () => {
    it("returns the same empty array untouched", async () => {
        const db = makeDb({ document_versions: [] });
        const docs: TestDoc[] = [];
        await expect(attachActiveVersionPaths(db, docs)).resolves.toBe(docs);
    });

    it("nulls all fields when no document has a current version", async () => {
        const db = makeDb({ document_versions: [FULL_VERSION] });
        const [doc] = await attachActiveVersionPaths<TestDoc>(db, [
            { id: "doc-1", current_version_id: null },
        ]);
        expect(doc).toMatchObject({
            filename: "Untitled document",
            storage_path: null,
            pdf_storage_path: null,
            file_type: null,
            size_bytes: null,
            page_count: null,
        });
    });

    it("merges active-version metadata onto each row", async () => {
        const db = makeDb({
            document_versions: [
                FULL_VERSION,
                {
                    ...FULL_VERSION,
                    id: "ver-2",
                    storage_path: "documents/u/doc-2/source.docx",
                    pdf_storage_path: null,
                    filename: "nda.docx",
                    version_number: 1,
                },
            ],
        });
        const docs = await attachActiveVersionPaths<TestDoc>(db, [
            { id: "doc-1", current_version_id: "ver-1" },
            { id: "doc-2", current_version_id: "ver-2" },
            { id: "doc-3", current_version_id: null },
        ]);
        expect(docs[0]).toMatchObject({
            storage_path: "documents/u/doc-1/source.pdf",
            pdf_storage_path: "documents/u/doc-1/converted.pdf",
            active_version_number: 3,
            filename: "contract.pdf",
            file_type: "application/pdf",
            size_bytes: 1024,
            page_count: 12,
        });
        expect(docs[1]).toMatchObject({
            storage_path: "documents/u/doc-2/source.docx",
            pdf_storage_path: null,
            active_version_number: 1,
            filename: "nda.docx",
        });
        // Mixed list: the version-less doc still gets explicit nulls.
        expect(docs[2]).toMatchObject({
            storage_path: null,
            filename: "Untitled document",
        });
    });

    it("falls back to 'Untitled document' for blank filenames", async () => {
        const db = makeDb({
            document_versions: [{ ...FULL_VERSION, filename: "   " }],
        });
        const [doc] = await attachActiveVersionPaths<TestDoc>(db, [
            { id: "doc-1", current_version_id: "ver-1" },
        ]);
        expect(doc.filename).toBe("Untitled document");
    });

    it("ignores soft-deleted versions", async () => {
        const db = makeDb({
            document_versions: [
                { ...FULL_VERSION, deleted_at: "2026-01-01T00:00:00Z" },
            ],
        });
        const [doc] = await attachActiveVersionPaths<TestDoc>(db, [
            { id: "doc-1", current_version_id: "ver-1" },
        ]);
        expect(doc.storage_path).toBeNull();
        expect(doc.filename).toBe("Untitled document");
    });
});

// ---------------------------------------------------------------------------
// attachLatestVersionNumbers
// ---------------------------------------------------------------------------

describe("attachLatestVersionNumbers", () => {
    const versionRow = (
        document_id: string,
        version_number: number | null,
        overrides: Row = {},
    ) => ({
        document_id,
        version_number,
        source: "assistant_edit",
        deleted_at: null,
        ...overrides,
    });

    it("returns the same empty array untouched", async () => {
        const db = makeDb({ document_versions: [] });
        const docs: TestDoc[] = [];
        await expect(attachLatestVersionNumbers(db, docs)).resolves.toBe(docs);
    });

    it("attaches the max assistant_edit version number per document", async () => {
        const db = makeDb({
            document_versions: [
                versionRow("doc-1", 1),
                versionRow("doc-1", 4),
                versionRow("doc-1", 2),
                versionRow("doc-2", 7),
            ],
        });
        const docs = await attachLatestVersionNumbers<TestDoc>(db, [
            { id: "doc-1" },
            { id: "doc-2" },
            { id: "doc-3" },
        ]);
        expect(docs.map((d) => d.latest_version_number)).toEqual([4, 7, null]);
    });

    it("ignores non-assistant_edit and soft-deleted versions", async () => {
        const db = makeDb({
            document_versions: [
                versionRow("doc-1", 9, { source: "upload" }),
                versionRow("doc-1", 8, { deleted_at: "2026-01-01T00:00:00Z" }),
                versionRow("doc-1", 2),
            ],
        });
        const docs = await attachLatestVersionNumbers<TestDoc>(db, [{ id: "doc-1" }]);
        expect(docs[0].latest_version_number).toBe(2);
    });
});

// Known SHA-256 vector for "abc" (FIPS 180-4). Call sites hand this helper a
// mix of Buffers, raw ArrayBuffers, and views into larger buffers, so each of
// those has to produce the same digest.
const ABC_SHA256 =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("contentSha256", () => {
    it("matches the known digest for a Buffer", () => {
        expect(contentSha256(Buffer.from("abc", "utf8"))).toBe(ABC_SHA256);
    });

    it("matches the known digest for a raw ArrayBuffer", () => {
        const buf = Buffer.from("abc", "utf8");
        const ab = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer;
        expect(contentSha256(ab)).toBe(ABC_SHA256);
    });

    it("respects a view's offset and length rather than its backing buffer", () => {
        const backing = Buffer.from("xxabcxx", "utf8");
        const view = new Uint8Array(backing.buffer, backing.byteOffset + 2, 3);
        expect(contentSha256(view)).toBe(ABC_SHA256);
    });

    it("hashes empty content without throwing", () => {
        expect(contentSha256(Buffer.alloc(0))).toBe(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    });

    it("produces different digests for a one-byte difference", () => {
        expect(contentSha256(Buffer.from("abc"))).not.toBe(
            contentSha256(Buffer.from("abd")),
        );
    });
});

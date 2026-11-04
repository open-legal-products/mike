import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { Db } from "../../../lib/supabase";
import { contentSha256 } from "../../../lib/documentVersions";
import { SpreadsheetValuesError } from "../../../lib/extraction/limits";

const mocks = vi.hoisted(() => ({ head: vi.fn(), stream: vi.fn(), extract: vi.fn(), access: vi.fn() }));
vi.mock("../../../lib/storage", () => ({ headFile: mocks.head, createFileReadStream: mocks.stream }));
vi.mock("../../../lib/extraction/isolated", async original => ({
    ...await original<typeof import("../../../lib/extraction/isolated")>(),
    withExtractionRequest: (work: (extract: typeof mocks.extract) => unknown) => work(mocks.extract),
}));
vi.mock("../../../lib/access", async original => ({
    ...await original<typeof import("../../../lib/access")>(), ensureDocAccess: mocks.access,
}));
import { getSpreadsheetValuesPreview, getSpreadsheetValuesSource } from "../documents.spreadsheetValues";

const DOC = "10000000-0000-4000-8000-000000000001";
const VERSION = "20000000-0000-4000-8000-000000000001";
const OTHER = "20000000-0000-4000-8000-000000000002";
const bytes = Buffer.from("synthetic BIFF bytes; decoder is independently tested");
const hash = contentSha256(bytes);
const values = { parserVersion: "0.20.3", sheets: [], warnings: [] };
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let dbError: string | null;
const calls: string[] = [];
const db = { from(table: string) {
    calls.push(table); const filters: Array<(row: Row) => boolean> = [];
    const result = () => dbError === table ? { data: null, error: new Error("synthetic private diagnostic") } :
        { data: rows[table]?.find(row => filters.every(matches => matches(row))) ?? null, error: null };
    const query = {
        select: (_columns: string) => query,
        eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
        is: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
        single: async () => result(), maybeSingle: async () => result(),
    }; return query;
} } as unknown as Db;
const args = { documentId: DOC, userId: "reader", userEmail: "reader@example.test" };

beforeEach(() => {
    vi.stubEnv("EXTRACTION_ISOLATION", "on");
    vi.clearAllMocks(); calls.length = 0; dbError = null;
    rows = {
        documents: [{ id: DOC, user_id: "owner", project_id: "allowed", workflow_id: null, archived_at: null, current_version_id: VERSION }],
        document_versions: [{ id: VERSION, document_id: DOC, deleted_at: null, storage_path: "synthetic/source.xls", file_type: "xls", filename: "Source.xls", content_sha256: hash }],
    };
    mocks.access.mockImplementation(async doc => ({ ok: doc.project_id === "allowed", isCreator: false, projectRole: "viewer" }));
    mocks.head.mockResolvedValue({ size: bytes.length });
    mocks.stream.mockImplementation(() => Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]));
    mocks.extract.mockResolvedValue(values);
});
afterEach(() => vi.unstubAllEnvs());

describe("source-bound spreadsheet values", () => {
    it("refuses disabled isolation before database or source work", async () => {
        vi.stubEnv("EXTRACTION_ISOLATION", "off");
        try {
            expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, code: "spreadsheet_values_unavailable" });
            expect(calls).toEqual([]); expect(mocks.head).not.toHaveBeenCalled();
        } finally { vi.unstubAllEnvs(); }
    });
    it("authorizes a shared viewer and pins both exact version and original bytes", async () => {
        expect(await getSpreadsheetValuesPreview(db, args)).toEqual({ ok: true, data: {
            source: { documentId: DOC, versionId: VERSION, sha256: hash, filename: "Source.xls", bytes: bytes.length }, values,
        } });
        expect(mocks.extract).toHaveBeenCalledWith("spreadsheetValues", expect.any(ArrayBuffer));
        expect(Buffer.from(mocks.extract.mock.calls[0][1])).toEqual(bytes);
        expect(mocks.access).toHaveBeenCalledTimes(2);
    });
    it.each(["not-a-uuid", ""])("does not fall back from malformed explicit version %j", async versionId => {
        expect(await getSpreadsheetValuesPreview(db, { ...args, versionId })).toMatchObject({ ok: false, kind: "not_found" });
        expect(mocks.head).not.toHaveBeenCalled();
    });
    it("refuses a version belonging to another document even when its UUID exists", async () => {
        rows.document_versions.push({ ...rows.document_versions[0], id: OTHER, document_id: "another-doc" });
        expect(await getSpreadsheetValuesPreview(db, { ...args, versionId: OTHER })).toMatchObject({ ok: false, kind: "not_found" });
        expect(mocks.stream).not.toHaveBeenCalled();
    });
    it.each(["missing", "archived", "inaccessible", "deleted-version"])("rejects %s before storage", async condition => {
        if (condition === "missing") rows.documents = [];
        if (condition === "archived") rows.documents[0].archived_at = "synthetic-date";
        if (condition === "inaccessible") rows.documents[0].project_id = "denied";
        if (condition === "deleted-version") rows.document_versions[0].deleted_at = "synthetic-date";
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, kind: "not_found" });
        expect(mocks.head).not.toHaveBeenCalled();
    });
    it("does not expose completed parser output after an in-memory move removes access", async () => {
        mocks.extract.mockImplementation(async () => { rows.documents[0].project_id = "denied"; return values; });
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, kind: "not_found" });
    });
    it("keeps an already resolved historical checkpoint when active pointer advances", async () => {
        mocks.extract.mockImplementation(async () => { rows.documents[0].current_version_id = OTHER; return values; });
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: true, data: { source: { versionId: VERSION, sha256: hash } } });
    });
    it.each(["hash", "path", "deleted"])("rejects in-flight %s revision changes", async field => {
        mocks.extract.mockImplementation(async () => {
            if (field === "hash") rows.document_versions[0].content_sha256 = "f".repeat(64);
            if (field === "path") rows.document_versions[0].storage_path = "synthetic/new.xls";
            if (field === "deleted") rows.document_versions[0].deleted_at = "synthetic-date";
            return values;
        });
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, kind: field === "deleted" ? "not_found" : "conflict" });
    });
    it("refuses stored hash mismatch before invoking parser", async () => {
        rows.document_versions[0].content_sha256 = "f".repeat(64);
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, code: "spreadsheet_values_changed" });
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it("computes a checkpoint for older versions without a stored hash", async () => {
        rows.document_versions[0].content_sha256 = null;
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: true, data: { source: { sha256: hash } } });
    });
    it.each(["metadata", "stream"])("bounds oversized %s without a preview", async stage => {
        if (stage === "metadata") mocks.head.mockResolvedValue({ size: 6 * 1024 * 1024 });
        else mocks.stream.mockImplementation(() => Readable.from([Buffer.alloc(5 * 1024 * 1024 + 1)]));
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, code: "spreadsheet_values_limit" });
        expect(mocks.extract).not.toHaveBeenCalled();
    });
    it("detects a stream length changing after HEAD", async () => {
        mocks.head.mockResolvedValue({ size: bytes.length + 1 });
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, code: "spreadsheet_values_changed" });
    });
    it.each(["documents", "document_versions"])("keeps %s database failure internal", async table => {
        dbError = table;
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, kind: "error" });
        expect(mocks.stream).not.toHaveBeenCalled();
    });
    it("distinguishes parser admission refusal from unexpected source failure", async () => {
        mocks.extract.mockRejectedValue(new SpreadsheetValuesError("spreadsheet_values_unsupported"));
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, code: "spreadsheet_values_unsupported" });
        mocks.stream.mockImplementation(() => Readable.from((async function* () { throw new Error("private storage diagnostic"); })()));
        expect(await getSpreadsheetValuesPreview(db, args)).toMatchObject({ ok: false, kind: "error" });
    });
    it("bounds a stalled metadata read and ignores its late completion", async () => {
        vi.useFakeTimers();
        try {
            let finish: (value: { size: number }) => void = () => {};
            mocks.head.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
            const result = getSpreadsheetValuesPreview(db, args);
            await vi.advanceTimersByTimeAsync(15_000);
            expect(await result).toMatchObject({ ok: false, kind: "error" });
            finish({ size: bytes.length }); await vi.advanceTimersByTimeAsync(0);
            expect(mocks.stream).not.toHaveBeenCalled(); expect(mocks.extract).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });
    it("cancels a pending metadata read without starting a later stream", async () => {
        const controller = new AbortController();
        let finish: (value: { size: number }) => void = () => {};
        mocks.head.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const result = getSpreadsheetValuesPreview(db, { ...args, signal: controller.signal });
        await vi.waitFor(() => expect(mocks.head).toHaveBeenCalled());
        controller.abort(); expect(await result).toMatchObject({ ok: false, kind: "error" });
        finish({ size: bytes.length }); await Promise.resolve();
        expect(mocks.stream).not.toHaveBeenCalled();
    });
});

describe("checkpoint original download", () => {
    const download = { ...args, versionId: VERSION, sha256: hash };
    it("returns exact original bytes without parsing or writing", async () => {
        const result = await getSpreadsheetValuesSource(db, download);
        expect(result.ok).toBe(true);
        if (result.ok) expect(Buffer.from(result.data.bytes)).toEqual(bytes);
        expect(mocks.extract).not.toHaveBeenCalled();
        expect(new Set(calls)).toEqual(new Set(["documents", "document_versions"]));
    });
    it.each([undefined, OTHER])("never falls back from missing/foreign version %j", async versionId => {
        expect(await getSpreadsheetValuesSource(db, { ...download, versionId })).toMatchObject({ ok: false, kind: "not_found" });
        expect(mocks.stream).not.toHaveBeenCalled();
    });
    it("refuses changed bytes even if an old version row still has no hash", async () => {
        rows.document_versions[0].content_sha256 = null;
        expect(await getSpreadsheetValuesSource(db, { ...download, sha256: "a".repeat(64) })).toMatchObject({ ok: false, code: "spreadsheet_values_changed" });
    });
    it("rechecks current authorization after the download read", async () => {
        mocks.stream.mockImplementation(() => Readable.from((async function* () {
            yield bytes; rows.documents[0].project_id = "denied";
        })()));
        expect(await getSpreadsheetValuesSource(db, download)).toMatchObject({ ok: false, kind: "not_found" });
    });
    it("does not parse or respond with bytes when cancelled", async () => {
        const controller = new AbortController(); controller.abort();
        expect(await getSpreadsheetValuesSource(db, { ...download, signal: controller.signal })).toMatchObject({ ok: false, kind: "error" });
        expect(mocks.extract).not.toHaveBeenCalled();
    });
});

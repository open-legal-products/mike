import { describe, it, expect } from "vitest";

import {
    normalizeDownloadFilename,
    sanitizeDispositionFilename,
    encodeRFC5987,
    buildContentDisposition,
    storageKey,
    generatedDocKey,
    versionStorageKey,
} from "../storage";

describe("normalizeDownloadFilename", () => {
    it("trims surrounding whitespace", () => {
        expect(normalizeDownloadFilename("  file.pdf  ")).toBe("file.pdf");
    });

    it("falls back to 'download' for empty string", () => {
        expect(normalizeDownloadFilename("")).toBe("download");
        expect(normalizeDownloadFilename("   ")).toBe("download");
    });

    it("replaces control characters with underscore", () => {
        expect(normalizeDownloadFilename("file\x00name.pdf")).toBe("file_name.pdf");
        expect(normalizeDownloadFilename("file\x1fname.pdf")).toBe("file_name.pdf");
    });

    it("replaces forward and backward slashes with underscore", () => {
        expect(normalizeDownloadFilename("dir/file.pdf")).toBe("dir_file.pdf");
        expect(normalizeDownloadFilename("dir\\file.pdf")).toBe("dir_file.pdf");
    });

    it("preserves normal filenames unchanged", () => {
        expect(normalizeDownloadFilename("Contract v2 (Final).pdf")).toBe(
            "Contract v2 (Final).pdf",
        );
    });
});

describe("sanitizeDispositionFilename", () => {
    it("strips double-quote characters", () => {
        expect(sanitizeDispositionFilename('file"name.pdf')).toBe("file_name.pdf");
    });

    it("strips backslash characters", () => {
        expect(sanitizeDispositionFilename("file\\name.pdf")).toBe("file_name.pdf");
    });

    it("strips non-ASCII characters", () => {
        expect(sanitizeDispositionFilename("filéname.pdf")).toBe("fil_name.pdf");
    });

    it("still applies normalizeDownloadFilename rules first", () => {
        expect(sanitizeDispositionFilename("  ")).toBe("download");
    });
});

describe("encodeRFC5987", () => {
    it("encodes spaces as %20", () => {
        expect(encodeRFC5987("hello world")).toBe("hello%20world");
    });

    it("encodes single-quote as %27", () => {
        expect(encodeRFC5987("it's")).toContain("%27");
    });

    it("encodes ( and ) as %28 and %29", () => {
        const result = encodeRFC5987("a(b)c");
        expect(result).toContain("%28");
        expect(result).toContain("%29");
    });

    it("encodes * as %2A", () => {
        expect(encodeRFC5987("a*b")).toContain("%2A");
    });

    it("leaves safe ASCII characters unencoded", () => {
        expect(encodeRFC5987("file.pdf")).toBe("file.pdf");
    });
});

describe("buildContentDisposition", () => {
    it("produces an attachment header with ASCII filename", () => {
        const header = buildContentDisposition("attachment", "contract.pdf");
        expect(header).toMatch(/^attachment;/);
        expect(header).toContain('filename="contract.pdf"');
        expect(header).toContain("filename*=UTF-8''contract.pdf");
    });

    it("produces an inline header", () => {
        const header = buildContentDisposition("inline", "preview.pdf");
        expect(header).toMatch(/^inline;/);
    });

    it("encodes unicode filename in filename* param", () => {
        const header = buildContentDisposition("attachment", "Ünïcödé.pdf");
        expect(header).toContain("filename*=UTF-8''");
        expect(header).not.toContain("Ü");
    });
});

describe("storageKey", () => {
    it("includes userId, docId, and correct extension", () => {
        const key = storageKey("user1", "doc1", "contract.pdf");
        expect(key).toBe("documents/user1/doc1/source.pdf");
    });

    it("falls back to .bin for extensions longer than 16 chars", () => {
        const key = storageKey("user1", "doc1", "file.toolongextension1234");
        expect(key).toBe("documents/user1/doc1/source.bin");
    });

    it("falls back to .bin when no extension", () => {
        const key = storageKey("user1", "doc1", "noextension");
        expect(key).toBe("documents/user1/doc1/source.bin");
    });
});

describe("generatedDocKey", () => {
    it("uses generated/ prefix and .docx extension for docx files", () => {
        const key = generatedDocKey("user1", "doc1", "output.docx");
        expect(key).toBe("generated/user1/doc1/generated.docx");
    });

    it("falls back to .docx for extensions longer than 16 chars", () => {
        const key = generatedDocKey("user1", "doc1", "output.toolongextension1234");
        expect(key).toBe("generated/user1/doc1/generated.docx");
    });
});

describe("versionStorageKey", () => {
    it("includes userId, docId, versionSlug, and extension", () => {
        const key = versionStorageKey("user1", "doc1", "v2", "contract.pdf");
        expect(key).toBe("documents/user1/doc1/versions/v2.pdf");
    });

    it("falls back to .bin for unknown extensions", () => {
        const key = versionStorageKey("user1", "doc1", "v2", "file");
        expect(key).toBe("documents/user1/doc1/versions/v2.bin");
    });
});

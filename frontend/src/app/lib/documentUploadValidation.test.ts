import { describe, expect, it } from "vitest";
import {
    SUPPORTED_DOCUMENT_ACCEPT,
    UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
    combineUploadWarnings,
    formatFailedUploadWarning,
    formatUnsupportedDocumentWarning,
    isSupportedDocumentFile,
    partitionSupportedDocumentFiles,
} from "./documentUploadValidation";

const file = (name: string) => new File(["content"], name);

describe("isSupportedDocumentFile", () => {
    it("accepts every extension advertised in SUPPORTED_DOCUMENT_ACCEPT", () => {
        // Keeps the <input accept=...> string and the validation set in sync:
        // if one gains an extension the other must too.
        const extensions = SUPPORTED_DOCUMENT_ACCEPT.split(",").map((s) =>
            s.replace(/^\./, ""),
        );
        expect(extensions.length).toBeGreaterThan(0);
        for (const ext of extensions) {
            expect(isSupportedDocumentFile(file(`contract.${ext}`))).toBe(true);
        }
    });

    it("is case-insensitive on the extension", () => {
        expect(isSupportedDocumentFile(file("SCAN.PDF"))).toBe(true);
        expect(isSupportedDocumentFile(file("Deed.DocX"))).toBe(true);
    });

    it("rejects unsupported types", () => {
        expect(isSupportedDocumentFile(file("notes.txt"))).toBe(false);
        expect(isSupportedDocumentFile(file("photo.png"))).toBe(false);
        expect(isSupportedDocumentFile(file("archive.zip"))).toBe(false);
    });

    it("uses only the last extension for multi-dot filenames", () => {
        expect(isSupportedDocumentFile(file("v1.2.final.pdf"))).toBe(true);
        expect(isSupportedDocumentFile(file("report.pdf.exe"))).toBe(false);
    });

    it("treats dotfiles like '.pdf' as having a pdf extension", () => {
        // ".pdf".split(".").pop() === "pdf" — documents current behavior.
        expect(isSupportedDocumentFile(file(".pdf"))).toBe(true);
    });

    it("treats an extensionless name equal to an extension as supported", () => {
        // "pdf".split(".").pop() === "pdf" — documents current behavior; a
        // file literally named "pdf" passes the extension check.
        expect(isSupportedDocumentFile(file("pdf"))).toBe(true);
        expect(isSupportedDocumentFile(file("README"))).toBe(false);
    });
});

describe("partitionSupportedDocumentFiles", () => {
    it("splits a mixed list preserving order within each bucket", () => {
        const a = file("a.pdf");
        const b = file("b.txt");
        const c = file("c.docx");
        const d = file("d.gif");
        const { supported, unsupported } = partitionSupportedDocumentFiles([
            a,
            b,
            c,
            d,
        ]);
        expect(supported).toEqual([a, c]);
        expect(unsupported).toEqual([b, d]);
    });

    it("returns two empty arrays for an empty input", () => {
        expect(partitionSupportedDocumentFiles([])).toEqual({
            supported: [],
            unsupported: [],
        });
    });
});

describe("formatUnsupportedDocumentWarning", () => {
    it("returns null when nothing was rejected", () => {
        expect(formatUnsupportedDocumentWarning([])).toBeNull();
    });

    it("returns the shared warning message when files were rejected", () => {
        expect(formatUnsupportedDocumentWarning([file("x.txt")])).toBe(
            UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
        );
    });
});

describe("formatFailedUploadWarning", () => {
    it("returns null when every upload succeeded", () => {
        expect(formatFailedUploadWarning([])).toBeNull();
    });

    it("names each failed file so outcomes are per-file, not batch-wide", () => {
        expect(formatFailedUploadWarning([file("a.pdf"), file("b.docx")])).toBe(
            "Could not upload a.pdf, b.docx. Please try again.",
        );
    });

    it("collapses long failure lists after the first three names", () => {
        const failed = ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"].map(file);
        expect(formatFailedUploadWarning(failed)).toBe(
            "Could not upload a.pdf, b.pdf, c.pdf and 2 more. Please try again.",
        );
    });
});

describe("combineUploadWarnings", () => {
    it("returns null when there is nothing to warn about", () => {
        expect(combineUploadWarnings(null, null)).toBeNull();
    });

    it("passes a single warning through unchanged", () => {
        expect(combineUploadWarnings(null, "Only warning.")).toBe(
            "Only warning.",
        );
    });

    it("joins unsupported-type and failed-upload warnings into one strip", () => {
        expect(combineUploadWarnings("First.", null, "Second.")).toBe(
            "First. Second.",
        );
    });
});

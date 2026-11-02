import { describe, expect, it } from "vitest";
import { convertedPdfKey } from "../convert";

describe("convertedPdfKey", () => {
    it("keys a document-level rendition by document id", () => {
        expect(convertedPdfKey("user1", "doc1")).toBe(
            "converted-pdfs/user1/doc1.pdf",
        );
    });

    it("keys a version rendition under the document by version slug", () => {
        expect(convertedPdfKey("user1", "doc1", "abc123")).toBe(
            "converted-pdfs/user1/doc1/abc123.pdf",
        );
    });
});

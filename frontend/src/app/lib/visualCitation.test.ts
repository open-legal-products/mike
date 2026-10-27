import { describe, expect, it } from "vitest";
import { citationFromVisualCite } from "./visualCitation";

const uuid = "4f1b7e8a-2c3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("citationFromVisualCite", () => {
    it("turns a document uuid into the citation the chat opens", () => {
        expect(
            citationFromVisualCite(
                { cite: uuid, version: "v1", quote: "the rent", page: "3", sheet: "Rent", cell: "B7" },
                "lease.xlsx",
            ),
        ).toEqual({
            type: "citation_data",
            kind: "document",
            ref: 0,
            doc_id: uuid,
            document_id: uuid,
            version_id: "v1",
            filename: "lease.xlsx",
            page: 3,
            quote: "the rent",
            sheet: "Rent",
            cell: "B7",
            quotes: [{ page: 3, quote: "the rent", sheet: "Rent", cell: "B7" }],
        });
        expect(citationFromVisualCite({ cite: uuid, page: "3-4" })).toMatchObject({
            version_id: null,
            filename: "",
            page: "3-4",
            quote: "",
            quotes: [],
        });
        expect(citationFromVisualCite({ cite: uuid })).toMatchObject({ page: "" });
    });

    it("returns null for the active document and for anything that is not a uuid", () => {
        expect(citationFromVisualCite({ cite: "active" })).toBeNull();
        expect(citationFromVisualCite({ cite: "lease.xlsx" })).toBeNull();
    });
});

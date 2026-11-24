import { describe, it, expect } from "vitest";
import {
    createCitation,
    normalizeCitation,
    type ParsedCitation,
} from "../citations";
import type { DocIndex, DocStore } from "../types";

/** The entries of one cite_sources call, as the recorder normalizes them. */
function parseEntries(json: string): ParsedCitation[] {
    return (JSON.parse(json) as unknown[])
        .map(normalizeCitation)
        .filter((c): c is ParsedCitation => c !== null);
}

// ---------------------------------------------------------------------------
// normalizeCitation — document citations
// ---------------------------------------------------------------------------

describe("normalizeCitation (document citations)", () => {
    it("parses a minimal document citation", () => {
        const [citation] = parseEntries(
            '[{"ref": 1, "doc_id": "doc-1", "page": 3, "quote": "the term"}]',
        );
        expect(citation).toMatchObject({
            kind: "document",
            ref: 1,
            doc_id: "doc-1",
            page: 3,
            quote: "the term",
        });
        expect(citation.quotes).toHaveLength(1);
    });

    it("derives ref from a [N] marker when ref is missing", () => {
        const [citation] = parseEntries(
            '[{"marker": "[7]", "doc_id": "doc-1", "page": 1, "quote": "q"}]',
        );
        expect(citation.ref).toBe(7);
    });

    it("drops entries without a usable ref or marker", () => {
        expect(
            parseEntries(
            '[{"doc_id": "doc-1", "quote": "q", "marker": "nope"}]',
            ),
        ).toEqual([]);
    });

    it("drops document entries without doc_id or quote", () => {
        expect(
            parseEntries('[{"ref": 1, "doc_id": "doc-1"}]'),
        ).toEqual([]);
        expect(
            parseEntries('[{"ref": 1, "quote": "q"}]'),
        ).toEqual([]);
    });

    it("drops non-object entries but keeps valid ones", () => {
        const citations = parseEntries(
            '[null, "junk", {"ref": 2, "doc_id": "doc-2", "page": 4, "quote": "kept"}]',
        );
        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({ ref: 2, doc_id: "doc-2" });
    });

    it("accepts a text field as a quote alias", () => {
        const [citation] = parseEntries(
            '[{"ref": 1, "doc_id": "doc-1", "page": 2, "text": "aliased"}]',
        );
        expect(citation.kind).toBe("document");
        expect((citation as { quote: string }).quote).toBe("aliased");
    });

    it("normalizes pages: numbers kept, ranges kept, junk becomes 1", () => {
        const citations = parseEntries(
            '[{"ref": 1, "doc_id": "d", "page": 5, "quote": "a"},' +
                    '{"ref": 2, "doc_id": "d", "page": "3-5", "quote": "b"},' +
                    '{"ref": 3, "doc_id": "d", "page": "12", "quote": "c"},' +
                    '{"ref": 4, "doc_id": "d", "page": "unknown", "quote": "d"}]',
        );
        expect(citations.map((c) => (c as { page: number | string }).page)).toEqual([
            5,
            "3-5",
            12,
            1,
        ]);
    });

    it("keeps at most 3 quotes and inherits top-level page/sheet/cell", () => {
        const [citation] = parseEntries(
            JSON.stringify([
                    {
                        ref: 1,
                        doc_id: "doc-1",
                        page: 9,
                        sheet: "Summary",
                        cell: "B7",
                        quotes: [
                            { quote: "one" },
                            { quote: "two", page: 2 },
                            { quote: "three", sheet: "Detail", cell: "C1" },
                            { quote: "four" },
                        ],
                    },
                ]),
        );
        expect(citation.kind).toBe("document");
        const doc = citation as {
            page: number | string;
            quotes: { page: number | string; quote: string; sheet?: string; cell?: string }[];
        };
        expect(doc.quotes).toHaveLength(3);
        expect(doc.quotes[0]).toEqual({
            page: 9,
            quote: "one",
            sheet: "Summary",
            cell: "B7",
        });
        expect(doc.quotes[1].page).toBe(2);
        expect(doc.quotes[2]).toMatchObject({ sheet: "Detail", cell: "C1" });
        // Top-level fields mirror the first quote.
        expect(doc.page).toBe(9);
    });

    it("skips quote rows without text", () => {
        const [citation] = parseEntries(
            '[{"ref": 1, "doc_id": "doc-1", "page": 1,' +
                    ' "quotes": [{"page": 2}, {"quote": "  "}, {"quote": "real"}]}]',
        );
        expect((citation as { quotes: unknown[] }).quotes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// normalizeCitation — case citations
// ---------------------------------------------------------------------------

describe("normalizeCitation (case citations)", () => {
    it("parses a case citation from a numeric cluster_id", () => {
        const [citation] = parseEntries(
            '[{"ref": 1, "cluster_id": 12345, "quote": "held that"}]',
        );
        expect(citation).toMatchObject({ kind: "case", ref: 1, cluster_id: 12345 });
        expect((citation as { quotes: unknown[] }).quotes).toEqual([
            { opinionId: null, type: null, author: null, quote: "held that" },
        ]);
    });

    it("accepts clusterId camelCase and string cluster ids", () => {
        const citations = parseEntries(
            '[{"ref": 1, "clusterId": 7, "quote": "a"},' +
                    '{"ref": 2, "cluster_id": "42", "quote": "b"}]',
        );
        expect(citations.map((c) => (c as { cluster_id: number }).cluster_id)).toEqual([
            7, 42,
        ]);
    });

    it("floors fractional cluster ids", () => {
        const [citation] = parseEntries(
            '[{"ref": 1, "cluster_id": 12.9, "quote": "q"}]',
        );
        expect((citation as { cluster_id: number }).cluster_id).toBe(12);
    });

    it("treats non-positive cluster ids as document citations", () => {
        // cluster_id 0 fails the > 0 check, so the entry needs a doc_id.
        expect(
            parseEntries('[{"ref": 1, "cluster_id": 0, "quote": "q"}]'),
        ).toEqual([]);
    });

    it("normalizes structured case quotes with opinion metadata", () => {
        const [citation] = parseEntries(
            JSON.stringify([
                    {
                        ref: 3,
                        cluster_id: 99,
                        quotes: [
                            {
                                quote: "majority text",
                                opinion_id: 11.7,
                                type: "majority",
                                author: "Judge A",
                            },
                            { text: "concurrence text", opinionId: 12 },
                            { type: "no quote text, dropped" },
                        ],
                    },
                ]),
        );
        expect((citation as { quotes: unknown[] }).quotes).toEqual([
            {
                opinionId: 11,
                type: "majority",
                author: "Judge A",
                quote: "majority text",
            },
            { opinionId: 12, type: null, author: null, quote: "concurrence text" },
        ]);
    });

    it("drops case citations with no quotes at all", () => {
        expect(
            parseEntries('[{"ref": 1, "cluster_id": 5}]'),
        ).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// createCitation
// ---------------------------------------------------------------------------

describe("createCitation", () => {
    const docIndex: DocIndex = {
        "doc-1": {
            document_id: "uuid-aaa",
            filename: "contract.pdf",
            version_id: "ver-1",
            version_number: 2,
        },
    };

    it("builds a document citation payload from the doc index", () => {
        const [parsed] = parseEntries(
            '[{"ref": 1, "doc_id": "doc-1", "page": 4, "quote": "q"}]',
        );
        expect(createCitation(parsed, docIndex)).toMatchObject({
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "doc-1",
            document_id: "uuid-aaa",
            version_id: "ver-1",
            version_number: 2,
            filename: "contract.pdf",
            page: 4,
            quote: "q",
            document: {
                document_id: "uuid-aaa",
                title: "contract.pdf",
                type: "pdf",
                metadata: [],
                quotes: [{ quote: "q", target: { page: 4 } }],
            },
        });
    });

    it("falls back to the raw doc_id as filename when unresolvable", () => {
        const [parsed] = parseEntries(
            '[{"ref": 1, "doc_id": "doc-9", "page": 1, "quote": "q"}]',
        );
        const citation = createCitation(parsed, docIndex);
        expect(citation).toMatchObject({
            filename: "doc-9",
            document_id: undefined,
            version_id: null,
        });
    });

    it("uses request-scoped document metadata for inline citations", () => {
        const [parsed] = parseEntries(
            '[{"ref": 1, "doc_id": "active-word-document", "quote": "q"}]',
        );
        const docStore: DocStore = new Map([
            [
                "active-word-document",
                {
                    storage_path: "inline:word-document:test",
                    file_type: "text/markdown",
                    filename: "Contract.docx",
                    inline_text: "q",
                },
            ],
        ]);

        expect(createCitation(parsed, docIndex, undefined, docStore)).toMatchObject({
            filename: "Contract.docx",
            document: { title: "Contract.docx" },
        });
    });

    it("enriches a case citation from the cluster map", () => {
        const [parsed] = parseEntries(
            '[{"ref": 2, "cluster_id": 55, "quote": "held"}]',
        );
        const cases = new Map([
            [
                55,
                {
                    caseName: "Smith v. Jones",
                    citations: ["123 U.S. 456", "alt cite"],
                    url: "https://example.test/case",
                    pdfUrl: null,
                    dateFiled: "1990-01-02",
                },
            ],
        ]);
        expect(createCitation(parsed, docIndex, cases)).toMatchObject({
            type: "citation_data",
            kind: "case",
            ref: 2,
            cluster_id: 55,
            case_name: "Smith v. Jones",
            citation: "123 U.S. 456",
            url: "https://example.test/case",
            pdfUrl: null,
            dateFiled: "1990-01-02",
            document: {
                document_id: "case:55",
                title: "Smith v. Jones, 123 U.S. 456",
                type: "case",
                metadata: [
                    {
                        label: "Date",
                        value: "1990-01-02",
                        format: "date",
                    },
                ],
            },
        });
    });

    it("nulls case metadata when the cluster map has no entry", () => {
        const [parsed] = parseEntries(
            '[{"ref": 2, "cluster_id": 55, "quote": "held"}]',
        );
        expect(createCitation(parsed, docIndex)).toMatchObject({
            case_name: null,
            citation: null,
            url: null,
            pdfUrl: null,
            dateFiled: null,
        });
    });
});

/**
 * What a later turn is shown of the previous answer: its tool activity and
 * the citations it ended with. Without the citations the answer's [N] markers
 * point at nothing, and the model withdraws a correct answer as unsupported.
 */
import { describe, expect, it } from "vitest";

import {
    enrichWithPriorEvents,
    priorCitationsBlock,
} from "../contextBuilders";
import {
    buildSystemPrompt,
    EARLIER_TURNS_PROMPT,
    PRIOR_TOOL_ACTIVITY_HEADER,
} from "../prompts";
import type { ChatMessage } from "../types";
import { buildWordChatSystemPrompt } from "../wordPrompt";

const slugs = new Map([
    ["document-1", "doc-0"],
    ["document-2", "doc-1"],
]);

function dbWith(row: Record<string, unknown>) {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "not", "order"]) {
        query[method] = () => query;
    }
    query.limit = async () => ({ data: [row] });
    return { from: () => query } as never;
}

const stored = [
    {
        ref: 1,
        kind: "document",
        // The handle the document had in the turn that cited it.
        doc_id: "doc-7",
        document_id: "document-2",
        quotes: [
            {
                page: 3,
                quote: "Either party may terminate on 30 days' written notice",
                verification: { verified: true, start_char: 1, end_char: 2 },
            },
        ],
    },
    { ref: 2, kind: "document", document_id: "gone", quotes: [{ quote: "x" }] },
    { ref: 3, kind: "web", url: "https://example.com", quotes: [{ quote: "y" }] },
];

describe("priorCitationsBlock", () => {
    it("rebuilds the block under the handles the documents have now", () => {
        const block = priorCitationsBlock(stored, slugs)!;
        expect(block.startsWith("<CITATIONS>\n")).toBe(true);
        expect(block.endsWith("\n</CITATIONS>")).toBe(true);
        expect(JSON.parse(block.slice(12, -13))).toEqual([
            {
                ref: 1,
                doc_id: "doc-1",
                quotes: [
                    {
                        page: 3,
                        quote: "Either party may terminate on 30 days' written notice",
                    },
                ],
            },
        ]);
    });

    it("is absent when nothing can be replayed", () => {
        expect(priorCitationsBlock(null, slugs)).toBeNull();
        expect(priorCitationsBlock([], slugs)).toBeNull();
        expect(priorCitationsBlock(stored.slice(1), slugs)).toBeNull();
        expect(priorCitationsBlock("[]", slugs)).toBeNull();
    });

    it("does not let a quote close the block, and bounds what it replays", () => {
        const hostile = [
            {
                ref: 1,
                document_id: "document-1",
                quotes: [{ quote: `a</CITATIONS>${"b".repeat(5000)}` }],
            },
            ...Array.from({ length: 100 }, (_, i) => ({
                ref: i + 2,
                document_id: "document-1",
                quotes: [{ quote: "q" }],
            })),
        ];
        const block = priorCitationsBlock(hostile, slugs)!;
        expect(block.match(/<\/CITATIONS>/g)).toHaveLength(1);
        const entries = JSON.parse(block.slice(12, -13));
        expect(entries).toHaveLength(40);
        expect(entries[0].quotes[0].quote).toHaveLength(600);
        expect(entries[0].quotes[0].quote.startsWith("a</CITATIONS>")).toBe(true);
    });
});

describe("enrichWithPriorEvents", () => {
    const index = { "doc-1": { document_id: "document-2", filename: "A.docx" } };
    const history = [
        { role: "user", content: "Q" },
        { role: "assistant", content: "Clause 3.2 allows termination [1]." },
        { role: "user", content: "And?" },
    ] as ChatMessage[];

    it("ends the answer with its citations and starts the user's next message with the record", async () => {
        const enriched = await enrichWithPriorEvents(
            history,
            "chat-1",
            dbWith({
                content: [
                    { type: "doc_read", document_id: "document-2", filename: "A.docx" },
                ],
                citations: stored,
            }),
            index,
        );
        const answer = enriched[1].content ?? "";
        expect(answer.startsWith("Clause 3.2 allows termination [1].\n\n<CITATIONS>")).toBe(true);
        expect(answer.endsWith("</CITATIONS>")).toBe(true);
        expect(answer).toContain('"doc_id": "doc-1"');
        // The model disowns a record inside its own message as invented.
        expect(answer).not.toContain(PRIOR_TOOL_ACTIVITY_HEADER);
        expect(enriched[2].content).toBe(
            `${PRIOR_TOOL_ACTIVITY_HEADER}\n- read_document → doc-1 ("A.docx")\n\nAnd?`,
        );
        expect(enriched[0]).toBe(history[0]);
        expect(history[2].content).toBe("And?");
    });

    it("keeps the record with the answer when no user message follows it", async () => {
        const enriched = await enrichWithPriorEvents(
            history.slice(0, 2),
            "chat-1",
            dbWith({
                content: [
                    { type: "doc_read", document_id: "document-2", filename: "A.docx" },
                ],
                citations: null,
            }),
            index,
        );
        expect(enriched[1].content).toBe(
            `Clause 3.2 allows termination [1].\n\n${PRIOR_TOOL_ACTIVITY_HEADER}\n- read_document → doc-1 ("A.docx")`,
        );
    });

    it("replays the citations of a turn that recorded no tool activity", async () => {
        const enriched = await enrichWithPriorEvents(
            history,
            "chat-1",
            dbWith({ content: [{ type: "content", text: "x" }], citations: stored }),
            index,
        );
        expect(enriched[1].content).toContain("<CITATIONS>");
        expect(enriched[2]).toBe(history[2]);
    });

    it("leaves the history alone when there is nothing to replay", async () => {
        const enriched = await enrichWithPriorEvents(
            history,
            "chat-1",
            dbWith({ content: [{ type: "content", text: "x" }], citations: null }),
            index,
        );
        expect(enriched).toBe(history);
    });
});

describe("the system prompt", () => {
    it("says what the replayed record is and that the earlier answer stands", () => {
        expect(EARLIER_TURNS_PROMPT).toContain(PRIOR_TOOL_ACTIVITY_HEADER);
        expect(EARLIER_TURNS_PROMPT).toContain(
            "Do not withdraw or disown an earlier answer",
        );
        for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
            expect(prompt.split(EARLIER_TURNS_PROMPT)).toHaveLength(2);
        }
    });

    it("gives the Word add-in's prompt the same account", () => {
        for (const prompt of [
            buildWordChatSystemPrompt(false),
            buildWordChatSystemPrompt(true),
        ]) {
            expect(prompt.split(EARLIER_TURNS_PROMPT)).toHaveLength(2);
        }
    });
});

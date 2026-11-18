/**
 * What a later turn is shown of the previous answer. Claude Sonnet 5.5
 * withdraws a correct earlier answer when the record of its tool calls sits
 * in its own message and its [N] markers point at nothing, so that model is
 * shown them differently. Every other model must see exactly what it did
 * before: the remedy changes how they answer.
 */
import { describe, expect, it } from "vitest";

import {
    buildMessages,
    enrichWithPriorEvents,
    priorCitationsBlock,
} from "../contextBuilders";
import {
    buildSystemPrompt,
    EARLIER_TURNS_PROMPT,
    PRIOR_TOOL_ACTIVITY_HEADER,
    PRIOR_TOOL_ACTIVITY_RECORD_HEADER,
} from "../prompts";
import { disownsReplayedToolRecord } from "../../../../lib/llm/models";
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

describe("disownsReplayedToolRecord", () => {
    it("is true for Claude Sonnet 5.5 on any route to it", () => {
        for (const model of [
            "claude-sonnet-5-5",
            "bedrock/us.anthropic.claude-sonnet-5-5",
            "vertex/claude-sonnet-5-5@20261001",
            "openrouter/anthropic/claude-sonnet-5.5",
            "vercel/anthropic/claude-sonnet-5.5",
        ]) {
            expect(disownsReplayedToolRecord(model), model).toBe(true);
        }
    });

    it("is false for every model the remedy was not measured to help", () => {
        for (const model of [
            "claude-fable-5-1",
            "claude-opus-5-5",
            "claude-haiku-4-5",
            "claude-sonnet-5",
            "claude-sonnet-5-50",
            "gpt-6.1-sol",
            "gemini-3.8-flash",
            "mistral-small-2603",
            "openrouter/openai/gpt-6.1-sol",
            "",
        ]) {
            expect(disownsReplayedToolRecord(model), model).toBe(false);
        }
    });
});

describe("enrichWithPriorEvents", () => {
    const index = { "doc-1": { document_id: "document-2", filename: "A.docx" } };
    const history = [
        { role: "user", content: "Q" },
        { role: "assistant", content: "Clause 3.2 allows termination [1]." },
        { role: "user", content: "And?" },
    ] as ChatMessage[];
    const read = { type: "doc_read", document_id: "document-2", filename: "A.docx" };
    const enrich = (
        messages: ChatMessage[],
        row: Record<string, unknown>,
        recordForUser?: boolean,
    ) =>
        enrichWithPriorEvents(
            messages,
            "chat-1",
            dbWith(row),
            index,
            undefined,
            "chat_messages",
            undefined,
            recordForUser,
        );

    describe("for every other model", () => {
        it("appends the record to the answer and replays no citations, as before", async () => {
            for (const flag of [undefined, false]) {
                const enriched = await enrich(history, { content: [read], citations: stored }, flag);
                expect(enriched[1].content).toBe(
                    `Clause 3.2 allows termination [1].\n\n[Tool activity in your previous turn]\n- read_document → doc-1 ("A.docx")`,
                );
                expect(enriched[0]).toBe(history[0]);
                expect(enriched[2]).toBe(history[2]);
            }
            expect(PRIOR_TOOL_ACTIVITY_HEADER).toBe("[Tool activity in your previous turn]");
        });

        it("leaves a turn with citations but no tool activity alone", async () => {
            const enriched = await enrich(history, {
                content: [{ type: "content", text: "x" }],
                citations: stored,
            });
            expect(enriched).toBe(history);
        });
    });

    describe("for a model that disowns the record", () => {
        it("ends the answer with its citations and starts the user's next message with the record", async () => {
            const enriched = await enrich(history, { content: [read], citations: stored }, true);
            const answer = enriched[1].content ?? "";
            expect(answer.startsWith("Clause 3.2 allows termination [1].\n\n<CITATIONS>")).toBe(true);
            expect(answer.endsWith("</CITATIONS>")).toBe(true);
            expect(answer).toContain('"doc_id": "doc-1"');
            expect(answer).not.toContain("previous turn");
            expect(enriched[2].content).toBe(
                `${PRIOR_TOOL_ACTIVITY_RECORD_HEADER}\n- read_document → doc-1 ("A.docx")\n\nAnd?`,
            );
            expect(enriched[0]).toBe(history[0]);
            expect(history[2].content).toBe("And?");
        });

        it("keeps the record with the answer when no user message follows it", async () => {
            const enriched = await enrich(history.slice(0, 2), { content: [read], citations: null }, true);
            expect(enriched[1].content).toBe(
                `Clause 3.2 allows termination [1].\n\n${PRIOR_TOOL_ACTIVITY_RECORD_HEADER}\n- read_document → doc-1 ("A.docx")`,
            );
        });

        it("replays the citations of a turn that recorded no tool activity", async () => {
            const enriched = await enrich(
                history,
                { content: [{ type: "content", text: "x" }], citations: stored },
                true,
            );
            expect(enriched[1].content).toContain("<CITATIONS>");
            expect(enriched[2]).toBe(history[2]);
        });

        it("leaves the history alone when there is nothing to replay", async () => {
            const enriched = await enrich(
                history,
                { content: [{ type: "content", text: "x" }], citations: null },
                true,
            );
            expect(enriched).toBe(history);
        });
    });
});

describe("the system prompt", () => {
    const system = (mode: "append" | "replace", recordForUser?: boolean) =>
        (
            buildMessages(
                [],
                [],
                mode === "replace" ? buildWordChatSystemPrompt() : "EXTRA",
                undefined,
                false,
                undefined,
                mode,
                undefined,
                recordForUser,
            )[0] as { content: string }
        ).content;

    it("is unchanged for every other model", () => {
        expect(buildSystemPrompt(true)).not.toContain("EARLIER TURNS");
        expect(buildSystemPrompt(false)).not.toContain("EARLIER TURNS");
        expect(buildWordChatSystemPrompt()).not.toContain("EARLIER TURNS");
        for (const mode of ["append", "replace"] as const) {
            expect(system(mode)).toBe(system(mode, false));
            expect(system(mode)).not.toContain("EARLIER TURNS");
        }
    });

    it("explains the record to a model that disowns it, in chat and in Word", () => {
        expect(EARLIER_TURNS_PROMPT).toContain(PRIOR_TOOL_ACTIVITY_RECORD_HEADER);
        expect(EARLIER_TURNS_PROMPT).toContain(
            "Do not withdraw or disown an earlier answer",
        );
        for (const mode of ["append", "replace"] as const) {
            const withAccount = system(mode, true);
            expect(withAccount.split(EARLIER_TURNS_PROMPT)).toHaveLength(2);
            // Nothing else about the prompt differs.
            expect(withAccount.replace(`\n\n${EARLIER_TURNS_PROMPT}`, "")).toBe(system(mode));
        }
    });
});

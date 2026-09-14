import { describe, it, expect } from "vitest";
import {
    MAX_ACTIVE_CHAT_AGENTS,
    agentCardInstruction,
    agentCardLabel,
    agentCardStatus,
    agentStatusLabel,
    agentsForMessage,
    applyProposalToEvents,
    assistantMessageText,
    findSourceMessageId,
    normalizeForMatch,
    pendingProposalExcerpts,
    replaceMessageById,
} from "./chatAgents";
import type { ChatAgent, Message } from "@/app/components/shared/types";

const agent = (over: Partial<ChatAgent> = {}): ChatAgent => ({
    id: "agent-1",
    title: null,
    agent_instruction: "check the indemnity clause carefully",
    source_message_id: "msg-1",
    source_excerpt: "the indemnity clause",
    created_at: "2026-08-26T10:00:00Z",
    status: "empty",
    pending_proposals: 0,
    ...over,
});

describe("agentCardLabel", () => {
    it("uses the first few words of the instruction", () => {
        expect(agentCardLabel({ agent_instruction: "check the indemnity clause carefully" }, 0)).toBe(
            "check the indemnity clause",
        );
    });

    it("keeps a short instruction whole", () => {
        expect(agentCardLabel({ agent_instruction: "tighten this" }, 2)).toBe(
            "tighten this",
        );
    });

    it("falls back to a numbered name when there is no instruction", () => {
        expect(agentCardLabel({ agent_instruction: "   " }, 2)).toBe("Agent 3");
        expect(agentCardLabel({ agent_instruction: null }, 0)).toBe("Agent 1");
        expect(agentCardLabel({}, 5)).toBe("Agent 6");
    });
});

describe("agentCardInstruction", () => {
    it("trims the instruction", () => {
        expect(agentCardInstruction({ agent_instruction: "  do it  " })).toBe(
            "do it",
        );
    });

    it("is empty when there is none", () => {
        expect(agentCardInstruction({ agent_instruction: null })).toBe("");
        expect(agentCardInstruction({})).toBe("");
    });
});

describe("agentCardStatus", () => {
    it("overlays processing while this client holds the stream open", () => {
        expect(agentCardStatus({ status: "empty" }, true)).toBe("processing");
        expect(agentCardStatus({ status: "ready" }, true)).toBe("processing");
    });

    it("otherwise reports what the server derived", () => {
        expect(agentCardStatus({ status: "ready" }, false)).toBe("ready");
        expect(agentCardStatus({ status: "empty" }, false)).toBe("empty");
    });
});

describe("agentStatusLabel", () => {
    it.each([
        ["processing" as const, "Processing"],
        ["ready" as const, "Ready"],
        ["empty" as const, "Needs rerun"],
    ])("labels %s", (status, label) => {
        expect(agentStatusLabel(status)).toBe(label);
    });
});

describe("applyProposalToEvents", () => {
    const events = [
        { type: "reasoning" as const, text: "the indemnity clause" },
        { type: "content" as const, text: "We rely on the indemnity clause here." },
        { type: "content" as const, text: "And the indemnity clause again." },
    ];

    it("replaces the first occurrence in prose", () => {
        const result = applyProposalToEvents(
            events,
            "the indemnity clause",
            "the indemnity and hold-harmless clause",
        );
        expect(result).toEqual({
            outcome: "applied",
            events: [
                events[0],
                {
                    type: "content",
                    text: "We rely on the indemnity and hold-harmless clause here.",
                },
                events[2],
            ],
        });
    });

    it("leaves reasoning and tool events alone", () => {
        const result = applyProposalToEvents(
            [{ type: "reasoning", text: "the indemnity clause" }],
            "the indemnity clause",
            "something else",
        );
        expect(result).toEqual({ outcome: "stale" });
    });

    it("supports a deletion", () => {
        const result = applyProposalToEvents(
            [{ type: "content", text: "keep this, drop that" }],
            ", drop that",
            "",
        );
        expect(result).toEqual({
            outcome: "applied",
            events: [{ type: "content", text: "keep this" }],
        });
    });

    it("reports stale when the target is gone", () => {
        expect(
            applyProposalToEvents(events, "a clause that moved on", "x"),
        ).toEqual({ outcome: "stale" });
    });

    it("reports stale for a missing message or an empty target", () => {
        expect(applyProposalToEvents(undefined, "a", "b")).toEqual({
            outcome: "stale",
        });
        expect(applyProposalToEvents(events, "", "b")).toEqual({
            outcome: "stale",
        });
    });
});

describe("assistantMessageText", () => {
    it("joins only the content events", () => {
        expect(
            assistantMessageText([
                { type: "reasoning", text: "hidden" },
                { type: "content", text: "one " },
                { type: "content", text: "two" },
            ]),
        ).toBe("one two");
    });

    it("is empty for a message with no events", () => {
        expect(assistantMessageText(undefined)).toBe("");
    });
});

describe("pendingProposalExcerpts", () => {
    it("lists each region that still has an unresolved proposal", () => {
        expect(
            pendingProposalExcerpts(
                [
                    agent({ id: "a", pending_proposals: 2 }),
                    agent({
                        id: "b",
                        pending_proposals: 1,
                        source_excerpt: " another region ",
                    }),
                    agent({ id: "c", pending_proposals: 0 }),
                ],
                "msg-1",
            ),
        ).toEqual(["the indemnity clause", "another region"]);
    });

    it("de-duplicates two agents assigned to the same region", () => {
        expect(
            pendingProposalExcerpts(
                [
                    agent({ id: "a", pending_proposals: 1 }),
                    agent({ id: "b", pending_proposals: 3 }),
                ],
                "msg-1",
            ),
        ).toEqual(["the indemnity clause"]);
    });

    it("ignores other messages, missing ids, and blank excerpts", () => {
        expect(
            pendingProposalExcerpts(
                [agent({ pending_proposals: 1, source_message_id: "other" })],
                "msg-1",
            ),
        ).toEqual([]);
        expect(pendingProposalExcerpts([agent()], undefined)).toEqual([]);
        expect(
            pendingProposalExcerpts(
                [agent({ pending_proposals: 1, source_excerpt: "  " })],
                "msg-1",
            ),
        ).toEqual([]);
    });
});

describe("agentsForMessage", () => {
    it("filters by the response the agent was assigned to", () => {
        const mine = agent({ id: "mine" });
        const other = agent({ id: "other", source_message_id: "msg-2" });
        expect(agentsForMessage([mine, other], "msg-1")).toEqual([mine]);
        expect(agentsForMessage([mine, other], undefined)).toEqual([]);
    });
});

describe("normalizeForMatch", () => {
    it("collapses whitespace so a cross-line selection still matches", () => {
        expect(normalizeForMatch("  the indemnity\n  clause  ")).toBe(
            "the indemnity clause",
        );
    });
});

describe("findSourceMessageId", () => {
    const messages: Message[] = [
        {
            id: "m1",
            role: "assistant",
            content: "",
            events: [{ type: "content", text: "the indemnity\nclause applies" }],
        },
        { id: "m2", role: "user", content: "and again?" },
        {
            id: "m3",
            role: "assistant",
            content: "",
            events: [{ type: "content", text: "the arbitration clause applies" }],
        },
    ];

    it("matches across a line break", () => {
        expect(findSourceMessageId(messages, "the indemnity clause")).toBe("m1");
    });

    it("prefers the newest response when both contain the phrase", () => {
        expect(findSourceMessageId(messages, "clause applies")).toBe("m3");
    });

    it("falls back to the flat content when there are no events", () => {
        expect(
            findSourceMessageId(
                [{ id: "m9", role: "assistant", content: "a stored answer" }],
                "stored answer",
            ),
        ).toBe("m9");
    });

    it("returns undefined for a phrase in no response, or a blank excerpt", () => {
        expect(findSourceMessageId(messages, "not present")).toBeUndefined();
        expect(findSourceMessageId(messages, "   ")).toBeUndefined();
    });

    it("ignores user messages and messages with no id", () => {
        expect(
            findSourceMessageId(
                [
                    { id: "u1", role: "user", content: "quotable words" },
                    { role: "assistant", content: "quotable words" },
                ],
                "quotable words",
            ),
        ).toBeUndefined();
    });
});

describe("replaceMessageById", () => {
    const messages: Message[] = [
        { id: "a", role: "assistant", content: "first" },
        { id: "b", role: "assistant", content: "second" },
    ];

    it("rewrites the addressed message and leaves the rest alone", () => {
        const next = replaceMessageById(messages, "b", (message) => ({
            ...message,
            content: "revised",
        }));
        expect(next[0]).toBe(messages[0]);
        expect(next[1]).toEqual({
            id: "b",
            role: "assistant",
            content: "revised",
        });
    });

    it("returns a copy when nothing matched", () => {
        const next = replaceMessageById(messages, "missing", (m) => m);
        expect(next).toEqual(messages);
        expect(next).not.toBe(messages);
    });
});

describe("MAX_ACTIVE_CHAT_AGENTS", () => {
    it("matches the server cap of six", () => {
        expect(MAX_ACTIVE_CHAT_AGENTS).toBe(6);
    });
});

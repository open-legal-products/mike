import { describe, it, expect } from "vitest";
import {
    MAX_ACTIVE_CHAT_AGENTS,
    MAX_AGENT_EXCERPT_CHARS,
    MAX_AGENT_INSTRUCTION_CHARS,
    PROPOSE_EDIT_TOOL,
    PROPOSE_EDIT_TOOL_NAME,
    buildChatAgentSeedMessage,
    buildChatAgentSystemPrompt,
    buildEditProposalEvent,
    countPendingEditProposals,
    createEditProposalToolsAdapter,
    deriveChatAgentStatus,
    parseAssistantMessageContent,
    parseOptionalAgentAssignment,
    setEditProposalStatus,
} from "../agents";

const proposal = (
    id: string,
    status: "pending" | "accepted" | "rejected" = "pending",
) => ({
    type: "edit_proposal" as const,
    proposal_id: id,
    target_excerpt: "old",
    replacement: "new",
    reason: null,
    status,
});

describe("parseOptionalAgentAssignment", () => {
    it("treats a body with no parent as an ordinary chat", () => {
        expect(parseOptionalAgentAssignment({ project_id: "p1" })).toEqual({
            ok: true,
            value: null,
        });
        expect(parseOptionalAgentAssignment({ parent_chat_id: null })).toEqual({
            ok: true,
            value: null,
        });
        expect(parseOptionalAgentAssignment(undefined)).toEqual({
            ok: true,
            value: null,
        });
    });

    it("trims and returns the four assignment fields", () => {
        expect(
            parseOptionalAgentAssignment({
                parent_chat_id: " chat-1 ",
                agent_instruction: "  check the indemnity  ",
                source_message_id: " msg-9 ",
                source_excerpt: "  the indemnity clause  ",
            }),
        ).toEqual({
            ok: true,
            value: {
                parentChatId: "chat-1",
                agentInstruction: "check the indemnity",
                sourceMessageId: "msg-9",
                sourceExcerpt: "the indemnity clause",
            },
        });
    });

    it("defaults the optional anchors to null", () => {
        const parsed = parseOptionalAgentAssignment({
            parent_chat_id: "chat-1",
            agent_instruction: "do the thing",
        });
        expect(parsed).toMatchObject({
            ok: true,
            value: { sourceMessageId: null, sourceExcerpt: null },
        });
    });

    it("requires an instruction once a parent is named", () => {
        expect(
            parseOptionalAgentAssignment({
                parent_chat_id: "chat-1",
                agent_instruction: "   ",
            }),
        ).toEqual({
            ok: false,
            detail: "agent_instruction must be a non-empty string",
        });
    });

    it.each([
        [
            { parent_chat_id: "  ", agent_instruction: "x" },
            "parent_chat_id must be a non-empty string",
        ],
        [
            {
                parent_chat_id: "chat-1",
                agent_instruction: "a".repeat(MAX_AGENT_INSTRUCTION_CHARS + 1),
            },
            `agent_instruction must be at most ${MAX_AGENT_INSTRUCTION_CHARS} characters`,
        ],
        [
            {
                parent_chat_id: "chat-1",
                agent_instruction: "x",
                source_message_id: "",
            },
            "source_message_id must be a non-empty string or null",
        ],
        [
            {
                parent_chat_id: "chat-1",
                agent_instruction: "x",
                source_excerpt: 12,
            },
            "source_excerpt must be a string or null",
        ],
        [
            {
                parent_chat_id: "chat-1",
                agent_instruction: "x",
                source_excerpt: "e".repeat(MAX_AGENT_EXCERPT_CHARS + 1),
            },
            `source_excerpt must be at most ${MAX_AGENT_EXCERPT_CHARS} characters`,
        ],
    ])("rejects %j", (body, detail) => {
        expect(parseOptionalAgentAssignment(body)).toEqual({
            ok: false,
            detail,
        });
    });

    it("caps agents at six, not four", () => {
        expect(MAX_ACTIVE_CHAT_AGENTS).toBe(6);
    });
});

describe("deriveChatAgentStatus", () => {
    it("is empty before any assistant message exists", () => {
        expect(
            deriveChatAgentStatus([{ role: "user", content: "seed" }]),
        ).toBe("empty");
    });

    it("is empty while the assistant row is only a reservation", () => {
        expect(
            deriveChatAgentStatus([
                { role: "user", content: "seed" },
                { role: "assistant", content: null },
            ]),
        ).toBe("empty");
    });

    it("is empty when the only assistant events are errors", () => {
        expect(
            deriveChatAgentStatus([
                {
                    role: "assistant",
                    content: [{ type: "error", message: "boom" }],
                },
            ]),
        ).toBe("empty");
    });

    it("is empty when the assistant produced only whitespace", () => {
        expect(
            deriveChatAgentStatus([
                { role: "assistant", content: [{ type: "content", text: "  " }] },
            ]),
        ).toBe("empty");
    });

    it("is ready once the newest assistant message carries content", () => {
        expect(
            deriveChatAgentStatus([
                { role: "user", content: "seed" },
                {
                    role: "assistant",
                    content: [{ type: "content", text: "here you go" }],
                },
            ]),
        ).toBe("ready");
    });

    it("is ready when the answer is a proposal with no prose", () => {
        expect(
            deriveChatAgentStatus([
                { role: "assistant", content: [proposal("p1")] },
            ]),
        ).toBe("ready");
    });

    it("reads the newest assistant message, not the first", () => {
        expect(
            deriveChatAgentStatus([
                {
                    role: "assistant",
                    content: [{ type: "content", text: "first answer" }],
                },
                { role: "user", content: "follow up" },
                { role: "assistant", content: null },
            ]),
        ).toBe("empty");
    });
});

describe("countPendingEditProposals", () => {
    it("counts only unresolved proposals across the whole thread", () => {
        expect(
            countPendingEditProposals([
                { role: "assistant", content: [proposal("a"), proposal("b")] },
                { role: "user", content: "and again" },
                {
                    role: "assistant",
                    content: [proposal("c", "accepted"), proposal("d")],
                },
            ]),
        ).toBe(3);
    });

    it("is zero for a thread with no proposals", () => {
        expect(
            countPendingEditProposals([
                {
                    role: "assistant",
                    content: [{ type: "content", text: "hi" }],
                },
                { role: "user", content: "hello" },
            ]),
        ).toBe(0);
    });
});

describe("propose_edit tool", () => {
    it("declares the three documented fields", () => {
        expect(PROPOSE_EDIT_TOOL.function.name).toBe("propose_edit");
        expect(PROPOSE_EDIT_TOOL.function.parameters).toMatchObject({
            required: ["target_excerpt", "replacement"],
        });
        expect(
            Object.keys(
                (
                    PROPOSE_EDIT_TOOL.function.parameters as {
                        properties: Record<string, unknown>;
                    }
                ).properties,
            ),
        ).toEqual(["target_excerpt", "replacement", "reason"]);
    });

    it("builds a pending proposal with a generated id", () => {
        const event = buildEditProposalEvent({
            target_excerpt: "  the indemnity clause ",
            replacement: "the indemnity and hold-harmless clause",
            reason: " clearer ",
        });
        expect(event).toMatchObject({
            type: "edit_proposal",
            target_excerpt: "the indemnity clause",
            replacement: "the indemnity and hold-harmless clause",
            reason: "clearer",
            status: "pending",
        });
        expect(event?.proposal_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("gives distinct ids to distinct proposals", () => {
        const first = buildEditProposalEvent({ target_excerpt: "a" });
        const second = buildEditProposalEvent({ target_excerpt: "a" });
        expect(first?.proposal_id).not.toBe(second?.proposal_id);
    });

    it("treats a missing reason as absent rather than empty", () => {
        expect(buildEditProposalEvent({ target_excerpt: "a" })).toMatchObject({
            reason: null,
            replacement: "",
        });
    });

    it("refuses a proposal with nothing to anchor to", () => {
        expect(buildEditProposalEvent({ target_excerpt: "   " })).toBeNull();
        expect(buildEditProposalEvent({})).toBeNull();
    });

    it("caps runaway target and replacement text", () => {
        const event = buildEditProposalEvent({
            target_excerpt: "t".repeat(MAX_AGENT_EXCERPT_CHARS + 500),
            replacement: "r".repeat(MAX_AGENT_EXCERPT_CHARS + 500),
        });
        expect(event?.target_excerpt).toHaveLength(MAX_AGENT_EXCERPT_CHARS);
        expect(event?.replacement).toHaveLength(MAX_AGENT_EXCERPT_CHARS);
    });

    it("owns only its own tool name", () => {
        const adapter = createEditProposalToolsAdapter();
        expect(adapter.owns(PROPOSE_EDIT_TOOL_NAME)).toBe(true);
        expect(adapter.owns("read_document")).toBe(false);
        expect(adapter.schemas).toEqual([PROPOSE_EDIT_TOOL]);
    });

    it("emits the proposal as an event and acknowledges the call", async () => {
        const adapter = createEditProposalToolsAdapter();
        const result = await adapter.execute({
            id: "call-1",
            name: PROPOSE_EDIT_TOOL_NAME,
            input: { target_excerpt: "old", replacement: "new" },
        });
        expect(result.events).toHaveLength(1);
        expect(result.events[0]).toMatchObject({ type: "edit_proposal" });
        const parsed = JSON.parse(result.content) as { ok: boolean };
        expect(parsed.ok).toBe(true);
    });

    it("reports an unanchored proposal back to the model", async () => {
        const adapter = createEditProposalToolsAdapter();
        const result = await adapter.execute({
            id: "call-1",
            name: PROPOSE_EDIT_TOOL_NAME,
            input: { replacement: "new" },
        });
        expect(result.events).toEqual([]);
        expect(JSON.parse(result.content)).toMatchObject({ ok: false });
    });
});

describe("buildChatAgentSystemPrompt", () => {
    it("states the role, the excerpt, and the instruction", () => {
        const prompt = buildChatAgentSystemPrompt({
            agent_instruction: "is this enforceable?",
            source_excerpt: "the arbitration clause",
        });
        expect(prompt).toContain("ASSIGNED AGENT ROLE");
        expect(prompt).toContain("ASSIGNED EXCERPT:\nthe arbitration clause");
        expect(prompt).toContain("ASSIGNED INSTRUCTION:\nis this enforceable?");
        expect(prompt).toContain("propose_edit");
    });

    it("omits the sections it has no content for", () => {
        const prompt = buildChatAgentSystemPrompt({
            agent_instruction: null,
            source_excerpt: null,
        });
        expect(prompt).not.toContain("ASSIGNED EXCERPT");
        expect(prompt).not.toContain("ASSIGNED INSTRUCTION");
    });
});

describe("buildChatAgentSeedMessage", () => {
    it("encodes the excerpt as a blockquote above the instruction", () => {
        expect(
            buildChatAgentSeedMessage({
                agent_instruction: "is this enforceable?",
                source_excerpt: "line one\nline two",
            }),
        ).toBe(
            [
                "Referring to this part of your earlier response:",
                "",
                "> line one",
                "> line two",
                "",
                "is this enforceable?",
            ].join("\n"),
        );
    });

    it("falls back to the bare instruction with no excerpt", () => {
        expect(
            buildChatAgentSeedMessage({
                agent_instruction: "just answer this",
                source_excerpt: null,
            }),
        ).toBe("just answer this");
    });
});

describe("parseAssistantMessageContent", () => {
    it("accepts an array of typed events", () => {
        expect(
            parseAssistantMessageContent([{ type: "content", text: "hi" }]),
        ).toEqual({ ok: true, value: [{ type: "content", text: "hi" }] });
    });

    it("accepts an empty array", () => {
        expect(parseAssistantMessageContent([])).toEqual({
            ok: true,
            value: [],
        });
    });

    it.each([
        ["a string", "plain text", "content must be an array of events"],
        [
            "an untyped member",
            [{ text: "hi" }],
            "content[0] must be an object with a type",
        ],
        [
            "a non-object member",
            [{ type: "content" }, "nope"],
            "content[1] must be an object with a type",
        ],
    ])("rejects %s", (_label, value, detail) => {
        expect(parseAssistantMessageContent(value)).toEqual({
            ok: false,
            detail,
        });
    });
});

describe("setEditProposalStatus", () => {
    it("updates only the addressed proposal", () => {
        const content = [
            { type: "content", text: "before" },
            proposal("a"),
            proposal("b"),
        ];
        expect(setEditProposalStatus(content, "b", "accepted")).toEqual([
            { type: "content", text: "before" },
            proposal("a"),
            proposal("b", "accepted"),
        ]);
    });

    it("returns null when the message has no such proposal", () => {
        expect(
            setEditProposalStatus([proposal("a")], "missing", "rejected"),
        ).toBeNull();
        expect(setEditProposalStatus(null, "a", "rejected")).toBeNull();
    });
});

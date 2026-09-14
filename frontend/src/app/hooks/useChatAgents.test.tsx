import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatAgents } from "./useChatAgents";
import type { AssistantEvent, Message } from "@/app/components/shared/types";

const {
    createChatAgent,
    getChat,
    listChatAgents,
    resolveEditProposal,
    streamChat,
    updateChatMessageContent,
    deleteChat,
} = vi.hoisted(() => ({
    createChatAgent: vi.fn(),
    getChat: vi.fn(),
    listChatAgents: vi.fn(),
    resolveEditProposal: vi.fn(),
    streamChat: vi.fn(),
    updateChatMessageContent: vi.fn(),
    deleteChat: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    createChatAgent,
    getChat,
    listChatAgents,
    resolveEditProposal,
    streamChat,
    updateChatMessageContent,
    deleteChat,
}));

/**
 * A stream whose frames are pushed by the test, so two agents can be held open
 * at the same time and interleaved deliberately.
 */
function controllableStream() {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        },
    });
    return {
        response: new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        }),
        push(frame: Record<string, unknown>) {
            controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
            );
        },
        close() {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    };
}

const createdAgent = (id: string, instruction: string) => ({
    id,
    title: instruction,
    agent_instruction: instruction,
    source_message_id: "msg-1",
    source_excerpt: "the indemnity clause",
    created_at: "2026-08-26T10:00:00Z",
});

beforeEach(() => {
    vi.clearAllMocks();
    listChatAgents.mockResolvedValue([]);
    getChat.mockResolvedValue({ chat: {}, messages: [] });
    resolveEditProposal.mockResolvedValue({
        proposal_id: "p1",
        status: "accepted",
    });
    updateChatMessageContent.mockResolvedValue({
        id: "msg-1",
        content: [],
        edited_at: "2026-08-26T11:00:00Z",
    });
    deleteChat.mockResolvedValue(undefined);
});

describe("useChatAgents — concurrency", () => {
    it("keeps two agents streaming at once, each writing only its own thread", async () => {
        const first = controllableStream();
        const second = controllableStream();
        createChatAgent
            .mockResolvedValueOnce(createdAgent("a", "check the indemnity"))
            .mockResolvedValueOnce(createdAgent("b", "find the counter"));
        streamChat
            .mockResolvedValueOnce(first.response)
            .mockResolvedValueOnce(second.response);

        const { result } = renderHook(() => useChatAgents("parent-1"));

        await act(async () => {
            await result.current.assignAgent({
                instruction: "check the indemnity",
                excerpt: "the indemnity clause",
                sourceMessageId: "msg-1",
            });
        });
        await act(async () => {
            await result.current.assignAgent({
                instruction: "find the counter",
                excerpt: "the indemnity clause",
                sourceMessageId: "msg-1",
            });
        });

        await waitFor(() => {
            expect(result.current.threads.a?.isStreaming).toBe(true);
            expect(result.current.threads.b?.isStreaming).toBe(true);
        });

        // Interleave the two streams: whatever the buffers do, agent A's text
        // must never appear in agent B's thread.
        await act(async () => {
            first.push({ type: "content_delta", text: "A-one " });
            second.push({ type: "content_delta", text: "B-one " });
            first.push({ type: "content_delta", text: "A-two" });
            second.push({ type: "content_delta", text: "B-two" });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        await waitFor(() => {
            expect(textOf(result.current.threads.a?.messages)).toBe("A-one A-two");
            expect(textOf(result.current.threads.b?.messages)).toBe("B-one B-two");
        });

        // Closing one stream leaves the other running.
        await act(async () => {
            first.close();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await waitFor(() => {
            expect(result.current.threads.a?.isStreaming).toBe(false);
            expect(result.current.threads.b?.isStreaming).toBe(true);
        });

        await act(async () => {
            second.close();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await waitFor(() =>
            expect(result.current.threads.b?.isStreaming).toBe(false),
        );
    });

    it("seeds the agent with the excerpt as a quote plus the instruction", async () => {
        const stream = controllableStream();
        createChatAgent.mockResolvedValue(createdAgent("a", "check this"));
        streamChat.mockResolvedValue(stream.response);

        const { result } = renderHook(() => useChatAgents("parent-1"));
        await act(async () => {
            await result.current.assignAgent({
                instruction: "check this",
                excerpt: "the indemnity clause",
            });
        });

        await waitFor(() => expect(streamChat).toHaveBeenCalled());
        const payload = streamChat.mock.calls[0][0] as {
            chat_id: string;
            messages: { role: string; content: string }[];
        };
        expect(payload.chat_id).toBe("a");
        expect(payload.messages).toEqual([
            {
                role: "user",
                content:
                    "Referring to this part of your earlier response:\n\n> the indemnity clause\n\ncheck this",
            },
        ]);

        await act(async () => {
            stream.close();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    });

    it("runs agent turns on the parent conversation's model", async () => {
        // Without inheritance an agent silently falls back to the server's
        // default model — which fails outright when that provider has no key.
        const stream = controllableStream();
        createChatAgent.mockResolvedValue(createdAgent("a", "check this"));
        streamChat.mockResolvedValue(stream.response);

        const { result } = renderHook(() =>
            useChatAgents("parent-1", "claude-sonnet-5"),
        );
        await act(async () => {
            await result.current.assignAgent({
                instruction: "check this",
                excerpt: "the indemnity clause",
            });
        });

        await waitFor(() => expect(streamChat).toHaveBeenCalled());
        expect(
            (streamChat.mock.calls[0][0] as { model?: string }).model,
        ).toBe("claude-sonnet-5");

        await act(async () => {
            stream.close();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    });

    it("omits the model when the parent conversation never chose one", async () => {
        const stream = controllableStream();
        createChatAgent.mockResolvedValue(createdAgent("a", "check this"));
        streamChat.mockResolvedValue(stream.response);

        const { result } = renderHook(() => useChatAgents("parent-1"));
        await act(async () => {
            await result.current.assignAgent({
                instruction: "check this",
                excerpt: "the indemnity clause",
            });
        });

        await waitFor(() => expect(streamChat).toHaveBeenCalled());
        expect(
            (streamChat.mock.calls[0][0] as { model?: string }).model,
        ).toBeUndefined();

        await act(async () => {
            stream.close();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    });
});

describe("useChatAgents — capacity", () => {
    it("refuses a seventh agent without calling the API", async () => {
        listChatAgents.mockResolvedValue(
            Array.from({ length: 6 }, (_, i) => ({
                id: `a${i}`,
                title: null,
                agent_instruction: "x",
                source_message_id: "msg-1",
                source_excerpt: "e",
                created_at: "2026-08-26T10:00:00Z",
                status: "ready" as const,
                pending_proposals: 0,
            })),
        );

        const { result } = renderHook(() => useChatAgents("parent-1"));
        await waitFor(() => expect(result.current.atCapacity).toBe(true));

        await act(async () => {
            await result.current.assignAgent({
                instruction: "one too many",
                excerpt: "e",
            });
        });

        expect(createChatAgent).not.toHaveBeenCalled();
        expect(result.current.assignError).toContain("6 agents");
    });
});

describe("useChatAgents — resolving a proposal", () => {
    const proposal: Extract<AssistantEvent, { type: "edit_proposal" }> = {
        type: "edit_proposal",
        proposal_id: "p1",
        target_excerpt: "the indemnity clause",
        replacement: "the indemnity and hold-harmless clause",
        reason: null,
        status: "pending",
    };

    const parentMessage: Message = {
        id: "msg-1",
        role: "assistant",
        content: "We rely on the indemnity clause.",
        events: [{ type: "content", text: "We rely on the indemnity clause." }],
    };

    it("rewrites the parent response, then marks the card resolved", async () => {
        const { result } = renderHook(() => useChatAgents("parent-1"));
        const onParentUpdated = vi.fn();

        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.resolveProposal({
                agentId: "a",
                proposal,
                status: "accepted",
                parentMessage,
                onParentUpdated,
            });
        });

        expect(outcome).toBe("applied");
        expect(updateChatMessageContent).toHaveBeenCalledWith(
            "parent-1",
            "msg-1",
            [
                {
                    type: "content",
                    text: "We rely on the indemnity and hold-harmless clause.",
                },
            ],
        );
        expect(resolveEditProposal).toHaveBeenCalledWith("a", "p1", "accepted");
        expect(onParentUpdated).toHaveBeenCalledWith(
            expect.objectContaining({
                content: "We rely on the indemnity and hold-harmless clause.",
                edited_at: "2026-08-26T11:00:00Z",
            }),
        );
    });

    it("writes nothing when the target text has moved on", async () => {
        const { result } = renderHook(() => useChatAgents("parent-1"));

        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.resolveProposal({
                agentId: "a",
                proposal,
                status: "accepted",
                parentMessage: {
                    ...parentMessage,
                    events: [
                        { type: "content", text: "This paragraph was rewritten." },
                    ],
                },
            });
        });

        expect(outcome).toBe("stale");
        expect(updateChatMessageContent).not.toHaveBeenCalled();
        expect(resolveEditProposal).not.toHaveBeenCalled();
    });

    it("rejecting never touches the parent response", async () => {
        const { result } = renderHook(() => useChatAgents("parent-1"));

        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.resolveProposal({
                agentId: "a",
                proposal,
                status: "rejected",
                parentMessage,
            });
        });

        expect(outcome).toBe("rejected");
        expect(updateChatMessageContent).not.toHaveBeenCalled();
        expect(resolveEditProposal).toHaveBeenCalledWith("a", "p1", "rejected");
    });

    it("reports a failed write instead of claiming the edit landed", async () => {
        updateChatMessageContent.mockRejectedValue(new Error("boom"));
        const { result } = renderHook(() => useChatAgents("parent-1"));

        let outcome: string | undefined;
        await act(async () => {
            outcome = await result.current.resolveProposal({
                agentId: "a",
                proposal,
                status: "accepted",
                parentMessage,
            });
        });

        expect(outcome).toBe("failed");
        expect(resolveEditProposal).not.toHaveBeenCalled();
    });
});

function textOf(messages: readonly Message[] | undefined): string {
    const assistant = [...(messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant");
    return (assistant?.events ?? [])
        .filter((event) => event.type === "content")
        .map((event) => (event as { text: string }).text)
        .join("");
}

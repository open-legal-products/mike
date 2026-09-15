/**
 * A first message is the one message the app sends from a mount effect rather
 * than from a click: `/assistant` hands the typed message to
 * `/assistant/chat/[id]`, which auto-sends it as soon as it mounts. That makes
 * it the only send that races React's mount-time effect replay, so it is the
 * only send that can be cancelled by request bookkeeping tied to effect
 * lifecycle instead of to the thread.
 *
 * StrictMode — on by default in Next dev — runs create/destroy/create for every
 * effect right after mount. A destroy pass that aborts the in-flight request
 * killed the auto-sent turn, and because the catch drops a superseded request
 * without surfacing it, the turn stalled forever on its empty assistant
 * placeholder: every first response rendered blank, with no error.
 */
import { StrictMode, useEffect, useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/app/components/shared/types";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        replaceChatId: vi.fn(),
        loadChats: vi.fn().mockResolvedValue(undefined),
        setCurrentChatId: vi.fn(),
        saveChat: vi.fn().mockResolvedValue("new-chat"),
        setNewChatMessages: vi.fn(),
        updateChatTitle: vi.fn(),
    }),
}));
import { useAssistantChat } from "./useAssistantChat";

const fetchMock = vi.fn();

/** A streaming SSE Response that yields between chunks, as the network does. */
const sseResponse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const chunk of chunks) {
                await Promise.resolve();
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
};

const firstMessage: Message = { role: "user", content: "hello" };

const transcript = (messages: Message[]) =>
    messages
        .map((message) => {
            const streamed = (message.events ?? [])
                .map((event) => ("text" in event ? (event.text ?? "") : ""))
                .join("");
            return `${message.role}:${message.content || streamed}`;
        })
        .join(" | ");

/** Mirrors /assistant/chat/[id]: mounts holding the carried user message and
 *  auto-sends it from an effect. */
function AutoSendingChat({ chatId }: { chatId?: string }) {
    const { messages, handleChat } = useAssistantChat({
        initialMessages: [firstMessage],
        chatId,
    });
    const hasAutoSent = useRef(false);
    useEffect(() => {
        if (hasAutoSent.current || messages.length !== 1) return;
        hasAutoSent.current = true;
        void handleChat(firstMessage);
    }, [messages.length, handleChat]);
    return <div data-testid="transcript">{transcript(messages)}</div>;
}

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("a first message auto-sent on mount", () => {
    it.each([
        ["plain render", false],
        ["StrictMode's mount-time effect replay", true],
    ])("streams its response through %s", async (_label, strict) => {
        fetchMock.mockResolvedValue(
            sseResponse([
                'data: {"type":"content_delta","text":"Hi there"}\n\n',
                "data: [DONE]\n\n",
            ]),
        );

        const chat = <AutoSendingChat chatId="chat-1" />;
        render(strict ? <StrictMode>{chat}</StrictMode> : chat);

        await waitFor(() =>
            expect(screen.getByTestId("transcript")).toHaveTextContent(
                "user:hello | assistant:Hi there",
            ),
        );
    });

    it("still invalidates the in-flight request when the host switches threads", async () => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        fetchMock.mockResolvedValue(
            new Response(
                new ReadableStream({
                    start(controller) {
                        stream = controller;
                    },
                }),
            ),
        );

        const { rerender } = render(
            <StrictMode>
                <AutoSendingChat chatId="chat-1" />
            </StrictMode>,
        );
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        rerender(
            <StrictMode>
                <AutoSendingChat chatId="chat-2" />
            </StrictMode>,
        );
        // An aborted stream is already closed; the point is only that nothing
        // the old thread emits can reach the new one.
        try {
            stream.enqueue(
                new TextEncoder().encode(
                    'data: {"type":"content_delta","text":"Late response"}\n\n',
                ),
            );
            stream.close();
        } catch {
            /* already torn down */
        }

        await waitFor(() =>
            expect(screen.getByTestId("transcript")).not.toHaveTextContent(
                "Late response",
            ),
        );
    });
});

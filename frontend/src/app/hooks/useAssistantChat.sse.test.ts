/**
 * SSE consumption tests for useAssistantChat — the frontend half of the SSE
 * contract. The backend streams `data: <json>\n\n` lines over a chunked
 * response; nothing guarantees chunk boundaries line up with event
 * boundaries, so the parser must buffer partial lines, handle several events
 * arriving in one chunk, surface `error` events, and flush whatever the
 * TextDecoder still holds when the stream closes without a trailing newline.
 * These tests drive the real hook against a mocked global fetch returning
 * genuine ReadableStream bodies (through the real streamChat in mikeApi.ts).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import type { Message } from "@/app/components/shared/types";

const { routerReplaceMock, updateChatTitleMock } = vi.hoisted(() => ({
    routerReplaceMock: vi.fn(),
    updateChatTitleMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: routerReplaceMock, push: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        replaceChatId: vi.fn(),
        loadChats: vi.fn().mockResolvedValue(undefined),
        setCurrentChatId: vi.fn(),
        saveChat: vi.fn().mockResolvedValue("new-chat"),
        setNewChatMessages: vi.fn(),
        updateChatTitle: updateChatTitleMock,
    }),
}));
import { useAssistantChat } from "./useAssistantChat";

const fetchMock = vi.fn();

/** A streaming SSE Response emitting exactly the given chunks, then EOF. */
const sseResponse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
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

const userMessage = (content = "hello"): Message => ({
    role: "user",
    content,
});

const sendAndGetAssistant = async (chunks: string[]) => {
    fetchMock.mockResolvedValue(sseResponse(chunks));
    const { result } = renderHook(() => useAssistantChat());
    let returnedChatId: string | null = null;
    await act(async () => {
        returnedChatId = await result.current.handleChat(userMessage());
    });
    const assistant = result.current.messages.findLast(
        (m) => m.role === "assistant",
    );
    return { result, assistant, returnedChatId };
};

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("useAssistantChat SSE parsing", () => {
    it("continues a project input request with its parent id, attachments and displayed document", async () => {
        fetchMock.mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
        const response = {
            type: "ask_inputs_response" as const,
            assistant_message_id: "assistant-1",
            ask_event_id: "ask-docs",
            responses: [{ id: "draft", kind: "documents" as const, filenames: ["Draft.pdf"] }],
        };
        const files = [{ filename: "Draft.pdf", document_id: "attachment-1" }];
        const { result } = renderHook(() => useAssistantChat({
            projectId: "project-1", chatId: "chat-1",
            initialMessages: [{ id: "assistant-1", role: "assistant", content: "", events: [] }],
        }));
        await act(async () => {
            await result.current.handleChat({ role: "user", content: "Draft attached", files }, {
                askInputsResponse: response,
                displayedDoc: { filename: "Comparison.docx", documentId: "project-doc-1" },
            });
        });
        const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
        expect(JSON.parse(request.body as string)).toMatchObject({
            chat_id: "chat-1",
            ask_inputs_response: response,
            attached_documents: files,
            displayed_doc: { filename: "Comparison.docx", document_id: "project-doc-1" },
            messages: [expect.anything(), expect.objectContaining({ role: "user", files })],
        });
    });

    it("creates a project chat only when the first message is submitted", async () => {
        fetchMock.mockResolvedValue(
            sseResponse([
                'data: {"type":"chat_id","chatId":"project-chat-1"}\n\n',
                "data: [DONE]\n\n",
            ]),
        );
        const { result } = renderHook(() =>
            useAssistantChat({ projectId: "project-1" }),
        );

        expect(fetchMock).not.toHaveBeenCalled();
        await act(async () => {
            await result.current.handleChat(userMessage("First message"));
        });

        const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
        expect(JSON.parse(request.body as string)).not.toHaveProperty(
            "chat_id",
        );
        expect(routerReplaceMock).toHaveBeenCalledWith(
            "/projects/project-1/assistant/chat/project-chat-1",
        );
    });

    it("adopts a newly created chat without navigating or discarding its response", async () => {
        const onChatCreated = vi.fn();
        fetchMock.mockResolvedValue(
            sseResponse([
                'data: {"type":"chat_id","chatId":"created-chat"}\n\n',
                'data: {"type":"content_delta","text":"First response"}\n\n',
            ]),
        );
        const { result, rerender } = renderHook(
            ({ chatId }: { chatId?: string }) =>
                useAssistantChat({
                    projectId: "project-1",
                    chatId,
                    onChatCreated,
                }),
            { initialProps: { chatId: undefined as string | undefined } },
        );
        await act(async () => {
            await result.current.handleChat(userMessage());
        });
        expect(onChatCreated).toHaveBeenCalledWith("created-chat");
        expect(routerReplaceMock).not.toHaveBeenCalled();
        const streamedMessages = result.current.messages;
        rerender({ chatId: "created-chat" });
        expect(result.current.messages).toEqual(streamedMessages);
        expect(streamedMessages.at(-1)?.events).toEqual([
            expect.objectContaining({ text: "First response" }),
        ]);
    });

    it("adopts the id once during streaming and still discards updates after switching chats", async () => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const encoder = new TextEncoder();
        fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
            start(controller) { stream = controller; },
        })));
        const onChatCreated = vi.fn();
        const { result, rerender } = renderHook(
            ({ chatId }: { chatId?: string }) => useAssistantChat({
                projectId: "project-1", chatId, onChatCreated,
            }),
            { initialProps: { chatId: undefined as string | undefined } },
        );
        let pending!: Promise<string | null>;
        act(() => { pending = result.current.handleChat(userMessage()); });
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        act(() => stream.enqueue(encoder.encode('data: {"type":"chat_id","chatId":"created-chat"}\n\n')));
        await waitFor(() => expect(onChatCreated).toHaveBeenCalledWith("created-chat"));
        rerender({ chatId: "created-chat" });
        expect(result.current.isResponseLoading).toBe(true);
        act(() => stream.enqueue(encoder.encode('data: {"type":"chat_id","chatId":"created-chat"}\n\ndata: {"type":"content_delta","text":"First response"}\n\n')));
        await waitFor(() => expect(result.current.messages.at(-1)?.events).toEqual([
            expect.objectContaining({ text: "First response" }),
        ]));
        expect(onChatCreated).toHaveBeenCalledTimes(1);
        rerender({ chatId: "other-chat" });
        await act(async () => {
            stream.enqueue(encoder.encode('data: {"type":"content_delta","text":"Late response"}\n\n'));
            stream.close();
            await pending;
        });
        expect(result.current.chatId).toBe("other-chat");
        expect(result.current.isResponseLoading).toBe(false);
        expect(result.current.messages.at(-1)?.events).toEqual([
            expect.objectContaining({ text: "First response" }),
        ]);
        expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    it("does not append a cancellation to a newly reset chat when abort rejects later", async () => {
        let rejectRequest!: (error: Error) => void;
        fetchMock.mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    rejectRequest = reject;
                }),
        );
        const { result } = renderHook(() =>
            useAssistantChat({ projectId: "project-1" }),
        );
        let pending!: Promise<string | null>;
        act(() => {
            pending = result.current.handleChat(userMessage());
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        act(() => result.current.resetChat());
        await act(async () => {
            rejectRequest(new DOMException("Aborted", "AbortError"));
            await pending;
        });
        expect(result.current.messages).toEqual([]);
        expect(result.current.isResponseLoading).toBe(false);
    });

    it("ignores late stream events and completion after another request has started", async () => {
        let oldStream!: ReadableStreamDefaultController<Uint8Array>;
        fetchMock.mockResolvedValueOnce(
            new Response(
                new ReadableStream({
                    start(controller) {
                        oldStream = controller;
                    },
                }),
            ),
        );
        const { result } = renderHook(() =>
            useAssistantChat({ projectId: "project-1" }),
        );
        let oldRequest!: Promise<string | null>;
        act(() => {
            oldRequest = result.current.handleChat(userMessage("Old turn"));
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        act(() => result.current.resetChat());
        let finishNew!: (response: Response) => void;
        fetchMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishNew = resolve;
                }),
        );
        let newRequest!: Promise<string | null>;
        act(() => {
            newRequest = result.current.handleChat(userMessage("New turn"));
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await act(async () => {
            oldStream.enqueue(
                new TextEncoder().encode(
                    'data: {"type":"chat_id","chatId":"old-chat"}\n\ndata: {"type":"content_delta","text":"Late old response"}\n\n',
                ),
            );
            oldStream.close();
            await oldRequest;
        });
        expect(result.current.isResponseLoading).toBe(true);
        expect(result.current.chatId).toBeUndefined();
        expect(result.current.messages[0].content).toBe("New turn");
        expect(result.current.messages.at(-1)?.events).toEqual([]);
        expect(routerReplaceMock).not.toHaveBeenCalled();
        await act(async () => {
            finishNew(
                sseResponse([
                    'data: {"type":"content_delta","text":"New response"}\n\n',
                ]),
            );
            await newRequest;
        });
        expect(result.current.messages.at(-1)?.events).toEqual([
            expect.objectContaining({ text: "New response" }),
        ]);
    });

    it("discards a server id received during a cancelled first turn before starting another chat", async () => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode('data: {"type":"chat_id","chatId":"cancelled-chat"}\n\n'));
        } })));
        const { result } = renderHook(() => useAssistantChat({ projectId: "project-1" }));
        let pending!: Promise<string | null>;
        act(() => { pending = result.current.handleChat(userMessage()); });
        await waitFor(() => expect(result.current.chatId).toBe("cancelled-chat"));
        act(() => result.current.resetChat());
        fetchMock.mockResolvedValueOnce(sseResponse(["data: [DONE]\n\n"]));
        await act(async () => {
            await result.current.handleChat(userMessage("New chat"));
            stream.close();
            await pending;
        });
        const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
        expect(JSON.parse(request.body as string)).not.toHaveProperty("chat_id");
        expect(result.current.messages[0].content).toBe("New chat");
        expect(result.current.chatId).toBeUndefined();
    });

    it("invalidates an in-flight request when the host switches threads", async () => {
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
        const { result, rerender } = renderHook(
            ({ chatId }) => useAssistantChat({ chatId }),
            { initialProps: { chatId: "old-chat" } },
        );
        let pending!: Promise<string | null>;
        act(() => {
            pending = result.current.handleChat(userMessage());
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        rerender({ chatId: "other-chat" });
        act(() => result.current.setMessages([userMessage("Other thread")]));
        await act(async () => {
            stream.enqueue(
                new TextEncoder().encode(
                    'data: {"type":"content_delta","text":"Late response"}\n\n',
                ),
            );
            stream.close();
            await pending;
        });
        expect(result.current.messages).toEqual([userMessage("Other thread")]);
        expect(result.current.isResponseLoading).toBe(false);
    });

    it("records Stop once in the current thread without waiting for the aborted request", async () => {
        let rejectRequest!: (error: Error) => void;
        fetchMock.mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    rejectRequest = reject;
                }),
        );
        const { result } = renderHook(() => useAssistantChat());
        let pending!: Promise<string | null>;
        act(() => {
            pending = result.current.handleChat(userMessage());
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        act(() => result.current.cancel());
        expect(result.current.messages.at(-1)?.events).toEqual([
            { type: "content", text: "Cancelled by user." },
        ]);
        await act(async () => {
            rejectRequest(new DOMException("Aborted", "AbortError"));
            await pending;
        });
        expect(result.current.messages.at(-1)?.events).toEqual([
            { type: "content", text: "Cancelled by user." },
        ]);
    });

    it("uses a newly selected chat id without remounting the workspace", async () => {
        fetchMock.mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
        const { result, rerender } = renderHook(
            ({ chatId }) =>
                useAssistantChat({ chatId, projectId: "project-1" }),
            { initialProps: { chatId: "chat-1" } },
        );

        rerender({ chatId: "chat-2" });
        await act(async () => {
            await result.current.handleChat(userMessage());
        });

        const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
        expect(JSON.parse(request.body as string)).toMatchObject({
            chat_id: "chat-2",
        });
    });

    it("reassembles an event split across chunk boundaries", async () => {
        const { assistant, result } = await sendAndGetAssistant([
            'data: {"type":"content_delta","te',
            'xt":"Hello"}\n\n',
            'data: {"type":"content_delta","text":" world"}\n\n',
            "data: [DONE]\n\n",
        ]);

        expect(assistant?.events).toEqual([
            { type: "content", text: "Hello world", isStreaming: true },
        ]);
        expect(result.current.isResponseLoading).toBe(false);
    });

    it("processes several events arriving in a single chunk", async () => {
        const { assistant, returnedChatId } = await sendAndGetAssistant([
            'data: {"type":"chat_id","chatId":"c-42"}\n' +
                'data: {"type":"content_delta","text":"A"}\n' +
                'data: {"type":"content_delta","text":"B"}\n\n',
        ]);

        // The streamed chat id is surfaced as the handleChat return value...
        expect(returnedChatId).toBe("c-42");
        // ...and consecutive deltas accumulate into one content event.
        expect(assistant?.events).toEqual([
            { type: "content", text: "AB", isStreaming: true },
        ]);
    });

    it("updates chat history as soon as a streamed title event arrives", async () => {
        await sendAndGetAssistant([
            'data: {"type":"chat_id","chatId":"c-42"}\n\n',
            'data: {"type":"chat_title","chatId":"c-42","title":"German Liquidity Review"}\n\n',
            'data: {"type":"content_delta","text":"Still streaming"}\n\n',
        ]);

        expect(updateChatTitleMock).toHaveBeenCalledWith(
            "c-42",
            "German Liquidity Review",
        );
    });

    it("preserves document identity across streamed search lifecycle events", async () => {
        const { assistant } = await sendAndGetAssistant([
            'data: {"type":"doc_find_start","filename":"agreement.pdf","document_id":"document-1","version_id":"version-2","version_number":2,"query":"termination"}\n\n',
            'data: {"type":"doc_find","filename":"agreement.pdf","document_id":"document-1","version_id":"version-2","version_number":2,"query":"termination","total_matches":2}\n\n',
        ]);

        expect(assistant?.events).toContainEqual({
            type: "doc_find",
            filename: "agreement.pdf",
            document_id: "document-1",
            version_id: "version-2",
            version_number: 2,
            query: "termination",
            total_matches: 2,
            isStreaming: false,
        });
    });

    it("finalizes reasoning when content starts, keeping event order", async () => {
        const { assistant } = await sendAndGetAssistant([
            'data: {"type":"reasoning_delta","text":"Let me "}\n\n',
            'data: {"type":"reasoning_delta","text":"think."}\n\n',
            'data: {"type":"content_delta","text":"Done."}\n\n',
        ]);

        expect(assistant?.events).toEqual([
            { type: "reasoning", text: "Let me think." },
            { type: "content", text: "Done.", isStreaming: true },
        ]);
    });

    it("sanitizes an unexpected error event and stops loading", async () => {
        const { assistant, result } = await sendAndGetAssistant([
            'data: {"type":"content_delta","text":"Part"}\n\n',
            'data: {"type":"error","message":"model unavailable"}\n\n',
        ]);

        expect(assistant?.error).toBe("Sorry, something went wrong.");
        // Streamed content is finalized before the error event is appended.
        expect(assistant?.events).toEqual([
            { type: "content", text: "Part" },
            { type: "error", message: "Sorry, something went wrong." },
        ]);
        expect(result.current.isResponseLoading).toBe(false);
        expect(result.current.isLoadingCitations).toBe(false);
    });

    it("preserves an explicitly safe, actionable error event", async () => {
        const { assistant } = await sendAndGetAssistant([
            'data: {"type":"error","message":"Select a saved model first.","safe_to_display":true}\n\n',
        ]);

        expect(assistant?.error).toBe("Select a saved model first.");
        expect(assistant?.events).toContainEqual({
            type: "error",
            message: "Select a saved model first.",
            safe_to_display: true,
        });
    });

    it("falls back to a readable message for blank error events", async () => {
        const { assistant } = await sendAndGetAssistant([
            'data: {"type":"error","message":"  "}\n\n',
        ]);

        expect(assistant?.error).toBe("Sorry, something went wrong.");
    });

    it("parses a final event when the stream ends without a trailing newline", async () => {
        const { assistant } = await sendAndGetAssistant([
            'data: {"type":"content_delta","text":"head "}\n\n',
            // EOF right after the JSON — no \n. The done-branch decoder flush
            // plus final buffer parse must still deliver this event.
            'data: {"type":"content_delta","text":"tail"}',
        ]);

        expect(assistant?.events).toEqual([
            { type: "content", text: "head tail", isStreaming: true },
        ]);
    });

    it("ignores malformed JSON lines and keeps consuming the stream", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { assistant } = await sendAndGetAssistant([
            "data: {not json}\n\n",
            'data: {"type":"content_delta","text":"still here"}\n\n',
        ]);
        warn.mockRestore();

        expect(assistant?.events).toEqual([
            { type: "content", text: "still here", isStreaming: true },
        ]);
    });

    it("attaches final citations and finalizes streaming content", async () => {
        const { assistant } = await sendAndGetAssistant([
            'data: {"type":"content_delta","text":"Cited."}\n\n',
            'data: {"type":"citations","status":"final","citations":[{"ref":1}]}\n\n',
        ]);

        expect(assistant?.citations).toEqual([{ ref: 1 }]);
        expect(assistant?.citationStatus).toBe("final");
        expect(assistant?.events).toEqual([
            { type: "content", text: "Cited." },
        ]);
    });

    it("reports a non-ok HTTP response as a message-level error", async () => {
        fetchMock.mockResolvedValue(
            new Response("quota exceeded", { status: 429 }),
        );
        const { result } = renderHook(() => useAssistantChat());
        let returned: string | null = "sentinel";
        await act(async () => {
            returned = await result.current.handleChat(userMessage());
        });

        expect(returned).toBeNull();
        const assistant = result.current.messages.findLast(
            (m) => m.role === "assistant",
        );
        expect(assistant?.error).toBe("Sorry, something went wrong.");
        expect(result.current.isResponseLoading).toBe(false);
    });

    it("does nothing for a whitespace-only user message", async () => {
        const { result } = renderHook(() => useAssistantChat());
        let returned: string | null = "sentinel";
        await act(async () => {
            returned = await result.current.handleChat(userMessage("   "));
        });

        expect(returned).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.current.messages).toEqual([]);
    });
});

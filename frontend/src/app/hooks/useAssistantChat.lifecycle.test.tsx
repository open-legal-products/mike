/**
 * Stream lifecycle tests for useAssistantChat: who is allowed to kill an
 * in-flight answer.
 *
 * The backend treats a closed response socket as a user cancellation — it
 * stops the model and persists the partial answer labelled "Cancelled by
 * user." (lib/chat/routeStreaming.ts, `res.on("close")`). So the only place
 * the client may abort the request, or cancel its reader, is the explicit
 * Stop control. Leaving the thread — the host switching to another chat,
 * starting a new one, or unmounting — must leave the request alone and merely
 * stop the orphaned loop from repainting a list it no longer owns.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/app/components/shared/types";

const { loadChatsMock, setCurrentChatIdMock, replaceMock } = vi.hoisted(() => ({
    loadChatsMock: vi.fn().mockResolvedValue(undefined),
    setCurrentChatIdMock: vi.fn(),
    replaceMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        replaceChatId: vi.fn(),
        loadChats: loadChatsMock,
        setCurrentChatId: setCurrentChatIdMock,
        saveChat: vi.fn().mockResolvedValue("new-chat"),
        setNewChatMessages: vi.fn(),
        updateChatTitle: vi.fn(),
    }),
}));
import { useAssistantChat } from "./useAssistantChat";

const fetchMock = vi.fn();

/**
 * A response body the test drives frame by frame, and that reports whether
 * the consumer cancelled the reader — cancelling is what closes the socket
 * and makes the backend truncate the answer.
 */
function controllableSseResponse() {
    const encoder = new TextEncoder();
    const state = { cancelled: false };
    let push!: (chunk: string) => void;
    let close!: () => void;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            push = (chunk) => controller.enqueue(encoder.encode(chunk));
            close = () => controller.close();
        },
        cancel() {
            state.cancelled = true;
        },
    });
    const response = new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
    // Let the hook's loop reach the awaited read() between our own steps.
    // A real-timer tick, not act(): the request helper awaits work that
    // React's async act() starves, so wrapping the send in act() deadlocks.
    const flush = async () => {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
        });
    };
    return {
        response,
        state,
        send: async (chunk: string) => {
            push(chunk);
            await flush();
        },
        close: async () => {
            close();
            await flush();
        },
    };
}

const userMessage = (content = "hello"): Message => ({ role: "user", content });

/** The AbortSignal the hook handed to fetch for the turn in flight. */
const signalOfLastRequest = (): AbortSignal =>
    (fetchMock.mock.calls.at(-1)?.[1] as { signal: AbortSignal }).signal;

/**
 * Start a turn and wait until its request has been issued. The turn's promise
 * is handed back inside an object: returning it directly from an async helper
 * would make the caller's `await` adopt it and block until the stream ends.
 */
async function startTurn(
    handleChat: (message: Message) => Promise<string | null>,
): Promise<{ turn: Promise<string | null> }> {
    let turn!: Promise<string | null>;
    act(() => {
        turn = handleChat(userMessage());
    });
    // A plain real-timer tick (not act()) lets the hook reach its first
    // awaited read(); React's async act() would wait on the pending request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return { turn };
}

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("useAssistantChat stream lifecycle", () => {
    it("detaches without aborting when the host switches to another thread mid-stream", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);

        const { result, rerender } = renderHook(
            ({ chatId }: { chatId: string }) => useAssistantChat({ chatId }),
            { initialProps: { chatId: "chat-a" } },
        );
        const { turn } = await startTurn(result.current.handleChat);
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');
        expect(result.current.isResponseLoading).toBe(true);

        // The project workspace keeps this hook mounted and swaps the thread.
        rerender({ chatId: "chat-b" });
        expect(result.current.isResponseLoading).toBe(false);

        // Everything after the switch belongs to a turn nobody is watching.
        await body.send('data: {"type":"content_delta","text":" and rest"}\n\n');
        await body.close();
        await turn;

        // The request outlives the thread: no abort, no reader cancel, so the
        // server finishes the answer and persists it in full...
        expect(signalOfLastRequest().aborted).toBe(false);
        expect(body.state.cancelled).toBe(false);
        // ...and the orphaned loop writes nothing into the new thread.
        expect(replaceMock).not.toHaveBeenCalled();
        expect(loadChatsMock).not.toHaveBeenCalled();
        const assistant = result.current.messages.findLast(
            (message) => message.role === "assistant",
        );
        const text = (assistant?.events ?? [])
            .map((event) => (event.type === "content" ? event.text : ""))
            .join("");
        expect(text).not.toContain("and rest");
        expect(text).not.toContain("Cancelled by user.");
    });

    it("detaches without aborting when detach() is called (leaving for another chat)", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);

        const { result } = renderHook(() => useAssistantChat({ chatId: "chat-a" }));
        const { turn } = await startTurn(result.current.handleChat);
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');

        await act(async () => {
            result.current.detach();
        });
        // Until the host navigates away, this is still a pending chat.
        expect(result.current.isResponseLoading).toBe(true);

        await body.send('data: {"type":"content_delta","text":" and rest"}\n\n');
        await body.close();
        await turn;

        expect(signalOfLastRequest().aborted).toBe(false);
        expect(body.state.cancelled).toBe(false);
        expect(loadChatsMock).not.toHaveBeenCalled();
    });

    it("detaches without aborting when resetChat() starts a new chat mid-stream", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);

        const { result } = renderHook(() => useAssistantChat({ chatId: "chat-a" }));
        const { turn } = await startTurn(result.current.handleChat);
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');

        await act(async () => {
            result.current.resetChat();
        });
        expect(result.current.messages).toEqual([]);
        expect(result.current.chatId).toBeUndefined();

        await body.send('data: {"type":"content_delta","text":" and rest"}\n\n');
        await body.close();
        await turn;

        expect(signalOfLastRequest().aborted).toBe(false);
        expect(body.state.cancelled).toBe(false);
        // The fresh, empty chat stays empty: the old turn cannot repaint it.
        expect(result.current.messages).toEqual([]);
    });

    it("detaches without aborting when the hook unmounts mid-stream", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);

        const { result, unmount } = renderHook(() => useAssistantChat());
        const { turn } = await startTurn(result.current.handleChat);
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');

        unmount();

        await body.send('data: {"type":"chat_id","chatId":"c-orphan"}\n\n');
        await body.send('data: {"type":"content_delta","text":" and rest"}\n\n');
        await body.close();
        await turn;

        expect(signalOfLastRequest().aborted).toBe(false);
        expect(body.state.cancelled).toBe(false);
        expect(replaceMock).not.toHaveBeenCalled();
        expect(setCurrentChatIdMock).not.toHaveBeenCalled();
    });

    it("aborts the request when the user presses Stop", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);

        const { result } = renderHook(() => useAssistantChat());
        const { turn } = await startTurn(result.current.handleChat);
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');

        await act(async () => {
            result.current.cancel();
        });
        expect(signalOfLastRequest().aborted).toBe(true);

        // The next read observes the aborted signal and unwinds the turn.
        // (A real fetch rejects the pending read; here a keep-alive comment
        // line carries no frame and just lets the loop go round again.)
        await body.send(": keep-alive\n\n");
        await turn;

        // Stop is the one path that may close the socket.
        expect(body.state.cancelled).toBe(true);
        const assistant = result.current.messages.findLast(
            (message) => message.role === "assistant",
        );
        expect(assistant?.events).toEqual([
            { type: "content", text: "Partial" },
            { type: "content", text: "Cancelled by user." },
        ]);
        expect(result.current.isResponseLoading).toBe(false);
    });
});


it.each(["switch", "remount"])("blocks duplicate turns after %s until the detached response completes", async (mode) => {
    const body = controllableSseResponse();
    fetchMock.mockResolvedValue(body.response);
    const first = renderHook(({ chatId }) => useAssistantChat({ chatId }), {
        initialProps: { chatId: "return-a" },
    });
    const { turn } = await startTurn(first.result.current.handleChat);
    await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');
    let returned = first;
    if (mode === "remount") {
        first.unmount();
        returned = renderHook(({ chatId }) => useAssistantChat({ chatId }), {
            initialProps: { chatId: "return-a" },
        });
    } else {
        first.rerender({ chatId: "other" });
        expect(first.result.current.isResponseLoading).toBe(false);
        first.rerender({ chatId: "return-a" });
    }
    expect(returned.result.current.isResponseLoading).toBe(true);
    await act(async () => { await returned.result.current.handleChat(userMessage("follow-up")); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await body.send('data: {"type":"content_delta","text":" finished"}\n\n');
    await body.close();
    await turn;
    expect(returned.result.current.isResponseLoading).toBe(false);
    returned.unmount();
});


it("can stop a detached request from a newly mounted owner", async () => {
    const body = controllableSseResponse();
    fetchMock.mockResolvedValue(body.response);
    const first = renderHook(() => useAssistantChat({ chatId: "stop-return" }));
    const { turn } = await startTurn(first.result.current.handleChat);
    const signal = signalOfLastRequest();
    first.unmount();
    const returned = renderHook(() => useAssistantChat({ chatId: "stop-return" }));
    act(() => returned.result.current.cancel());
    expect(signal.aborted).toBe(true);
    await body.send(": keep-alive\n\n");
    await act(async () => { await turn; });
    expect(returned.result.current.isResponseLoading).toBe(false);
});

/**
 * Coming back to a thread whose answer is still streaming. The turn record,
 * not the hook that sent the request, owns the answer while it streams, so a
 * hook that returns to the thread (the workspace swapping the chat back, or
 * the page mounting again) attaches to it and shows the same live answer.
 */
describe("returning to a thread while its answer streams", () => {
    const assistantText = (messages: Message[]) =>
        (messages.findLast((message) => message.role === "assistant")?.events ?? [])
            .map((event) => (event.type === "content" ? event.text : ""))
            .join("");
    /** The stored question, as a history read returns it before the answer row has content. */
    const storedQuestion = (): Message => ({ id: "u1", role: "user", content: "hello" });

    it("shows the live answer, token by token, after switching away and back", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);
        const { result, rerender } = renderHook(
            ({ chatId }: { chatId: string }) => useAssistantChat({ chatId }),
            { initialProps: { chatId: "chat-a" } },
        );
        const { turn } = await startTurn(result.current.handleChat);
        await body.send('data: {"type":"chat_id","chatId":"chat-a","assistantMessageId":"answer-1"}\n\n');
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');

        rerender({ chatId: "chat-b" });
        act(() => result.current.setMessages([userMessage("about b")]));
        await body.send('data: {"type":"content_delta","text":" while away"}\n\n');
        // Nothing from the detached turn lands in the other thread.
        expect(result.current.messages).toEqual([userMessage("about b")]);
        expect(result.current.isResponseLoading).toBe(false);

        rerender({ chatId: "chat-a" });
        // The host loads chat-a's history: the question is stored, the answer
        // row is hidden until it has content. The live answer is laid over it.
        act(() => result.current.setMessages([storedQuestion()]));
        expect(result.current.isResponseLoading).toBe(true);
        expect(result.current.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(assistantText(result.current.messages)).toBe("Partial while away");

        await body.send('data: {"type":"content_delta","text":" and back"}\n\n');
        expect(assistantText(result.current.messages)).toBe("Partial while away and back");

        await body.close();
        await turn;
        expect(result.current.isResponseLoading).toBe(false);
        expect(assistantText(result.current.messages)).toBe("Partial while away and back");
        expect(result.current.messages.at(-1)?.id).toBe("answer-1");
        expect(signalOfLastRequest().aborted).toBe(false);
        expect(body.state.cancelled).toBe(false);
    });

    it("attaches a freshly mounted hook to the answer already streaming", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);
        const first = renderHook(() => useAssistantChat({ chatId: "chat-a" }));
        const { turn } = await startTurn(first.result.current.handleChat);
        await body.send('data: {"type":"chat_id","chatId":"chat-a","assistantMessageId":"answer-1"}\n\n');
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');
        first.unmount();

        const returned = renderHook(() => useAssistantChat({ chatId: "chat-a" }));
        // Attached on mount, before any history has been set.
        expect(returned.result.current.isResponseLoading).toBe(true);
        expect(assistantText(returned.result.current.messages)).toBe("Partial");
        act(() => returned.result.current.setMessages([storedQuestion()]));
        expect(returned.result.current.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

        await body.send('data: {"type":"content_delta","text":" and the rest"}\n\n');
        expect(assistantText(returned.result.current.messages)).toBe("Partial and the rest");
        await body.close();
        await turn;
        expect(returned.result.current.isResponseLoading).toBe(false);
        expect(assistantText(returned.result.current.messages)).toBe("Partial and the rest");
        returned.unmount();
    });

    it("keeps the finished answer when a history read that predates it lands", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);
        const { result } = renderHook(() => useAssistantChat({ chatId: "chat-a" }));
        const { turn } = await startTurn(result.current.handleChat);
        await body.send('data: {"type":"chat_id","chatId":"chat-a","assistantMessageId":"answer-1"}\n\n');
        await body.send('data: {"type":"content_delta","text":"Whole answer"}\n\n');
        await body.close();
        await turn;
        expect(result.current.isResponseLoading).toBe(false);

        // A GET issued before the server stored the row resolves now.
        act(() => result.current.setMessages([storedQuestion()]));
        expect(result.current.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(assistantText(result.current.messages)).toBe("Whole answer");
        // A later, complete read replaces the row in place.
        act(() =>
            result.current.setMessages([
                storedQuestion(),
                { id: "answer-1", role: "assistant", content: "", events: [{ type: "content", text: "Whole answer" }] },
            ]),
        );
        expect(result.current.messages).toHaveLength(2);
    });

    it("labels the answer for the reader who stops it after returning", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);
        const first = renderHook(() => useAssistantChat({ chatId: "chat-a" }));
        const { turn } = await startTurn(first.result.current.handleChat);
        await body.send('data: {"type":"chat_id","chatId":"chat-a","assistantMessageId":"answer-1"}\n\n');
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');
        first.unmount();

        const returned = renderHook(() => useAssistantChat({ chatId: "chat-a" }));
        act(() => returned.result.current.cancel());
        expect(signalOfLastRequest().aborted).toBe(true);
        expect(returned.result.current.isResponseLoading).toBe(false);
        // What the server will store, shown without waiting for it.
        expect(returned.result.current.messages.at(-1)?.events).toEqual([
            { type: "content", text: "Partial" },
            { type: "content", text: "Cancelled by user." },
        ]);
        await body.send(": keep-alive\n\n");
        await act(async () => { await turn; });
        expect(body.state.cancelled).toBe(true);
        expect(returned.result.current.messages.at(-1)?.events).toHaveLength(2);
        returned.unmount();
    });
});


describe("Stop reaches the server", () => {
    it("names the turn to the Stop endpoint, then stops reading", async () => {
        const body = controllableSseResponse();
        fetchMock.mockResolvedValue(body.response);
        const { result } = renderHook(() => useAssistantChat({ chatId: "chat-a" }));
        const { turn } = await startTurn(result.current.handleChat);
        await body.send('data: {"type":"chat_id","chatId":"chat-a","turnId":"turn-1","assistantMessageId":"answer-1"}\n\n');
        await body.send('data: {"type":"content_delta","text":"Partial"}\n\n');
        const streamSignal = signalOfLastRequest();

        await act(async () => {
            result.current.cancel();
        });
        // Closing the socket only detaches now; the server is told to stop.
        const stop = fetchMock.mock.calls.find(([url]) =>
            String(url).endsWith("/chat/chat-a/turn/turn-1/stop"),
        );
        expect(stop?.[1]).toMatchObject({ method: "POST" });
        expect(streamSignal.aborted).toBe(true);
        await body.send(": keep-alive\n\n");
        await turn;
        expect(result.current.messages.at(-1)?.events).toEqual([
            { type: "content", text: "Partial" },
            { type: "content", text: "Cancelled by user." },
        ]);
    });
});

/**
 * Retry contract for useAssistantChat.
 *
 * An error toast that carries actions never auto-dismisses, so its "Retry"
 * can fire long after the turn that raised it: the chat may have been given
 * an id mid-stream, the host may have swapped threads underneath it, or a
 * newer turn may already be streaming. These tests pin that a Retry replays
 * the turn it was raised for — into the chat that turn landed in — or
 * refuses visibly, never destructively.
 *
 * Same harness as useAssistantChat.sse.test.ts: the real hook, a mocked
 * global fetch returning genuine ReadableStream SSE bodies, and `useToasts`
 * to read the toast and click its action.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/app/components/shared/types";

const { routerReplaceMock, reportErrorMock } = vi.hoisted(() => ({
    routerReplaceMock: vi.fn(),
    reportErrorMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: routerReplaceMock, push: vi.fn() }),
}));
vi.mock("@/app/lib/errorReporting", () => ({
    reportError: reportErrorMock,
    trackPendingRequest: () => () => {},
    reportNetworkFailure: vi.fn(),
    reportApiFailure: vi.fn(),
    // notifyError asks whether a fault was already reported before it
    // reports a 5xx itself; nothing in these tests pre-reports.
    isReported: () => false,
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
import { clearToasts, useToasts, type ToastRecord } from "@/shared/ui/ToastUI";

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

const userMessage = (content = "why?"): Message => ({
    role: "user",
    content,
});

const requestBody = (call: number) =>
    JSON.parse(
        (fetchMock.mock.calls[call]?.[1] as RequestInit).body as string,
    ) as { chat_id?: string; messages: { role: string; content: string }[] };

const retryAction = (toast?: ToastRecord) =>
    toast?.actions?.find((action) => action.label === "Retry");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // notifyError logs the cause in dev; the failures here are deliberate.
    errorSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearToasts();
});

afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    clearToasts();
});

describe("useAssistantChat retry", () => {
    it("does not resend from a toast after its chat view unmounts", async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'data: {"type":"chat_id","chatId":"left-chat"}\n\n',
            'data: {"type":"error","message":"failed"}\n\n',
        ]));
        const { result, unmount } = renderHook(() => ({ chat: useAssistantChat(), toasts: useToasts() }));
        await act(async () => { await result.current.chat.handleChat(userMessage()); });
        const retry = retryAction(result.current.toasts[0]);
        expect(retry).toBeDefined();
        unmount();
        await act(async () => { await retry?.onClick(); });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("re-sends a failed first turn into the chat the stream created", async () => {
        // The first attempt is given an id and then dies. Retry must continue
        // that chat; sending no id would have the backend create a second one
        // and navigate away from the failed turn.
        fetchMock.mockResolvedValueOnce(
            sseResponse([
                'data: {"type":"chat_id","chatId":"created-chat"}\n\n',
                'data: {"type":"error","message":"provider exploded: stack"}\n\n',
            ]),
        );
        // Stands in for the backend: continue the chat whose id was sent,
        // create a new one when none was.
        fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
            const sent = JSON.parse(init.body as string) as {
                chat_id?: string;
            };
            return Promise.resolve(
                sseResponse([
                    `data: {"type":"chat_id","chatId":"${sent.chat_id ?? "second-chat"}"}\n\n`,
                    'data: {"type":"content_delta","text":"Second go."}\n\n',
                ]),
            );
        });
        const { result } = renderHook(() => ({
            chat: useAssistantChat(),
            toasts: useToasts(),
        }));

        await act(async () => {
            await result.current.chat.handleChat(userMessage());
        });
        expect(requestBody(0).chat_id).toBeUndefined();

        const retry = retryAction(result.current.toasts[0]);
        expect(retry).toBeDefined();
        await act(async () => {
            await retry?.onClick();
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(requestBody(1).chat_id).toBe("created-chat");
        expect(requestBody(1).messages).toEqual([
            { role: "user", content: "why?" },
        ]);
        expect(
            result.current.chat.messages.filter((m) => m.role === "user"),
        ).toHaveLength(1);
        expect(routerReplaceMock).not.toHaveBeenCalledWith(
            "/assistant/chat/second-chat",
        );
    });

    it("refuses a retry raised in a thread the host has since switched away from", async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse(['data: {"type":"error","message":"boom"}\n\n']),
        );
        const { result, rerender } = renderHook(
            ({ chatId }: { chatId: string }) => ({
                chat: useAssistantChat({ chatId, projectId: "project-1" }),
                toasts: useToasts(),
            }),
            { initialProps: { chatId: "chat-a" } },
        );
        await act(async () => {
            await result.current.chat.handleChat(userMessage("question A"));
        });
        const retry = retryAction(result.current.toasts[0]);
        expect(retry).toBeDefined();

        // The project chat page swaps threads by writing straight through the
        // setters, so the hook now shows chat B's transcript.
        rerender({ chatId: "chat-b" });
        act(() =>
            result.current.chat.setMessages([userMessage("question B")]),
        );

        await act(async () => {
            await retry?.onClick();
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.current.chat.messages).toEqual([
            userMessage("question B"),
        ]);
        expect(result.current.toasts.at(-1)?.message).toBe(
            "This chat has changed. Send the message again from the chat it belongs to.",
        );
    });

    it("ignores a stale retry while a newer turn is streaming", async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse(['data: {"type":"error","message":"boom"}\n\n']),
        );
        let liveStream!: ReadableStreamDefaultController<Uint8Array>;
        fetchMock.mockResolvedValueOnce(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        liveStream = controller;
                    },
                }),
            ),
        );
        const { result } = renderHook(() => ({
            chat: useAssistantChat({ chatId: "chat-1" }),
            toasts: useToasts(),
        }));
        await act(async () => {
            await result.current.chat.handleChat(userMessage("first"));
        });
        const staleRetry = retryAction(result.current.toasts[0]);
        expect(staleRetry).toBeDefined();

        let secondTurn!: Promise<string | null>;
        act(() => {
            secondTurn = result.current.chat.handleChat(userMessage("second"));
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        const liveSignal = (fetchMock.mock.calls[1]?.[1] as RequestInit)
            .signal as AbortSignal;

        await act(async () => {
            await staleRetry?.onClick();
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(liveSignal.aborted).toBe(false);
        expect(result.current.toasts.at(-1)?.message).toBe(
            "A newer message has replaced this one. Send it again if you still need an answer.",
        );

        // The healthy turn keeps streaming into its own bubble.
        await act(async () => {
            liveStream.enqueue(
                new TextEncoder().encode(
                    'data: {"type":"content_delta","text":"Still here."}\n\n',
                ),
            );
            liveStream.close();
            await secondTurn;
        });
        expect(result.current.chat.messages.at(-1)?.events).toEqual([
            { type: "content", text: "Still here.", isStreaming: true },
        ]);
    });

    it("offers support but no retry for a configuration refusal", async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse([
                'data: {"type":"error","message":"Add an API key in Settings to use this model.","safe_to_display":true}\n\n',
            ]),
        );
        const { result } = renderHook(() => ({
            chat: useAssistantChat(),
            toasts: useToasts(),
        }));
        await act(async () => {
            await result.current.chat.handleChat(userMessage());
        });

        const toast = result.current.toasts[0];
        expect(toast?.message).toBe(
            "Add an API key in Settings to use this model.",
        );
        // Re-sending a refusal fails identically, so Retry would be dishonest.
        expect(retryAction(toast)).toBeUndefined();
        expect(toast?.supportHref).toMatch(/^mailto:/);
    });

    it("still offers a retry for an unsafe server failure", async () => {
        fetchMock.mockResolvedValueOnce(
            sseResponse([
                'data: {"type":"error","message":"provider exploded: stack"}\n\n',
            ]),
        );
        const { result } = renderHook(() => ({
            chat: useAssistantChat(),
            toasts: useToasts(),
        }));
        await act(async () => {
            await result.current.chat.handleChat(userMessage());
        });

        const toast = result.current.toasts[0];
        expect(toast?.message).toBe(
            "Mike couldn't finish this answer. Try again.",
        );
        expect(retryAction(toast)).toBeDefined();
        expect(toast?.supportHref).toMatch(/^mailto:/);
    });

    it("shows the backend's 4xx detail and carries its request id", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    code: "rate_limited",
                    detail: "Too many chat requests.",
                    request_id: "r1",
                }),
                {
                    status: 429,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        const { result } = renderHook(() => ({
            chat: useAssistantChat(),
            toasts: useToasts(),
        }));
        await act(async () => {
            await result.current.chat.handleChat(userMessage());
        });

        const assistant = result.current.chat.messages.findLast(
            (m) => m.role === "assistant",
        );
        expect(assistant?.error).toBe("Too many chat requests.");
        expect(result.current.toasts[0]?.message).toBe(
            "Too many chat requests.",
        );
        // The classification and the support hand-off both read these off the
        // thrown error, so they have to survive the non-ok branch.
        const reported = reportErrorMock.mock.calls[0]?.[0] as {
            status?: number;
            code?: string;
            requestId?: string;
        };
        expect(reported).toMatchObject({
            status: 429,
            code: "rate_limited",
            requestId: "r1",
        });
    });
});

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    deleteTabularChat,
    getTabularChats,
    getTabularChatMessages,
    renameTabularChat,
    stopTabularChatTurn,
    streamTabularChat,
    streamTabularChatTurn,
    type TRChat,
} from "@/app/lib/mikeApi";
import { TRChatPanel } from "./TRChatPanel";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getTabularChats: vi.fn(),
    getTabularChatMessages: vi.fn(),
    deleteTabularChat: vi.fn(),
    renameTabularChat: vi.fn(),
    streamTabularChat: vi.fn(),
    streamTabularChatTurn: vi.fn(),
    stopTabularChatTurn: vi.fn(),
}));
vi.mock("../assistant/ChatInput", () => ({
    ChatInput: ({
        onSubmit,
        onCancel,
        canSend = true,
    }: {
        onSubmit: (message: {
            role: "user";
            content: string;
            model: string;
            reasoning: "medium";
        }) => void;
        onCancel?: () => void;
        canSend?: boolean;
    }) => (
        <>
            <button
                type="button"
                disabled={!canSend}
                onClick={() =>
                    onSubmit({
                        role: "user",
                        content: "Review this table",
                        model: "claude-opus-4-7",
                        reasoning: "medium",
                    })
                }
            >
                Send test message
            </button>
            <button type="button" onClick={() => onCancel?.()}>
                Stop test message
            </button>
        </>
    ),
}));

describe("TRChatPanel header", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                disconnect() {}
            },
        );
        const now = Date.now();
        vi.mocked(getTabularChats).mockResolvedValue([
            {
                id: "chat-1",
                title: "Current draft",
                created_at: new Date(now - 60_000).toISOString(),
            },
            {
                id: "chat-2",
                title: "Earlier advice",
                created_at: new Date(now - 120_000).toISOString(),
            },
        ] as TRChat[]);
        vi.mocked(getTabularChatMessages).mockResolvedValue([]);
        vi.mocked(renameTabularChat).mockResolvedValue(undefined);
        vi.mocked(deleteTabularChat).mockResolvedValue(undefined);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("ignores an initial history response after switching to another thread", async () => {
        type History = Awaited<ReturnType<typeof getTabularChatMessages>>;
        let resolveInitial!: (messages: History) => void;
        vi.mocked(getTabularChatMessages).mockImplementation(async (_reviewId, chatId) => {
            if (chatId === "chat-1") return new Promise<History>((resolve) => { resolveInitial = resolve; });
            return [{ id: "new-message", chat_id: chatId, role: "user", content: "Newly selected thread", created_at: "2026-09-29" }];
        });
        render(<TRChatPanel reviewId="review-1" initialChatId="chat-1" onCitationClick={vi.fn()} />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Current draft" }));
        await user.click(screen.getByRole("menuitem", { name: /Earlier advice/ }));
        expect(await screen.findByText("Newly selected thread")).toBeInTheDocument();
        await act(async () => resolveInitial([{ id: "stale", chat_id: "chat-1", role: "user", content: "Stale initial history", created_at: "2026-09-29" }]));
        expect(screen.queryByText("Stale initial history")).not.toBeInTheDocument();
        expect(screen.getByText("Newly selected thread")).toBeInTheDocument();
    });

    it("keeps the latest of sixteen rapid history selections when requests finish backwards", async () => {
        type History = Awaited<ReturnType<typeof getTabularChatMessages>>;
        const pending: { chatId: string; resolve: (messages: History) => void }[] = [];
        vi.mocked(getTabularChatMessages).mockImplementation((_reviewId, chatId) =>
            new Promise<History>((resolve) => pending.push({ chatId, resolve })));
        render(<TRChatPanel reviewId="review-1" initialChatId="chat-1" onCitationClick={vi.fn()} />);
        const user = userEvent.setup();
        await screen.findByRole("button", { name: "Current draft" });
        for (let i = 0; i < 16; i++) {
            await user.click(screen.getByRole("button", { name: i % 2 ? "Earlier advice" : "Current draft" }));
            await user.click(screen.getByRole("menuitem", { name: i % 2 ? /Current draft/ : /Earlier advice/ }));
        }
        expect(pending).toHaveLength(17);
        for (let i = pending.length - 1; i >= 0; i--) {
            await act(async () => pending[i].resolve([{ id: `m-${i}`, chat_id: pending[i].chatId,
                role: "user", content: `Selection ${i}`, created_at: "2026-09-29" }]));
        }
        expect(screen.getByText("Selection 16")).toBeInTheDocument();
        expect(screen.queryByText("Selection 0")).not.toBeInTheDocument();
    });

    it("ignores an old history failure while the latest selection is still loading", async () => {
        type History = Awaited<ReturnType<typeof getTabularChatMessages>>;
        let rejectInitial!: (error: Error) => void;
        let resolveLatest!: (messages: History) => void;
        vi.mocked(getTabularChatMessages)
            .mockReturnValueOnce(new Promise<History>((_resolve, reject) => { rejectInitial = reject; }))
            .mockReturnValueOnce(new Promise<History>((resolve) => { resolveLatest = resolve; }));
        render(<TRChatPanel reviewId="review-1" initialChatId="chat-1" onCitationClick={vi.fn()} />);
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Current draft" }));
        await user.click(screen.getByRole("menuitem", { name: /Earlier advice/ }));
        await act(async () => rejectInitial(new Error("Old request failed")));
        expect(screen.queryByText("Chat unavailable")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Actions" }));
        // An obsolete finally handler must not clear the latest loading state.
        expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
        await user.keyboard("{Escape}");
        await act(async () => resolveLatest([{ id: "current", chat_id: "chat-2", role: "user", content: "Latest history", created_at: "2026-09-29" }]));
        expect(screen.getByText("Latest history")).toBeInTheDocument();
    });

    it.each(["success", "failure"] as const)("keeps a new chat empty after the previous history returns %s", async (outcome) => {
        type History = Awaited<ReturnType<typeof getTabularChatMessages>>;
        let resolveHistory!: (messages: History) => void;
        let rejectHistory!: (error: Error) => void;
        vi.mocked(getTabularChatMessages).mockReturnValueOnce(new Promise<History>((resolve, reject) => {
            resolveHistory = resolve;
            rejectHistory = reject;
        }));
        render(<TRChatPanel reviewId="review-1" initialChatId="chat-1" onCitationClick={vi.fn()} />);
        const user = userEvent.setup();
        await screen.findByRole("button", { name: "Current draft" });
        await user.click(screen.getByRole("button", { name: "New chat" }));
        await act(async () => {
            if (outcome === "success") resolveHistory([{ id: "old", chat_id: "chat-1", role: "user", content: "Retired history", created_at: "2026-09-29" }]);
            else rejectHistory(new Error("Retired request failed"));
        });
        expect(screen.queryByText("Retired history")).not.toBeInTheDocument();
        expect(screen.queryByText("Chat unavailable")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "New Chat", exact: true })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    });

    it("positions loaded history below the header and remeasures equal-length threads", async () => {
        let resolveMessages!: (
            messages: Awaited<ReturnType<typeof getTabularChatMessages>>,
        ) => void;
        vi.mocked(getTabularChatMessages).mockReturnValueOnce(
            new Promise((resolve) => {
                resolveMessages = resolve;
            }),
        );
        let userHeight = 60;
        vi.spyOn(
            HTMLElement.prototype,
            "offsetHeight",
            "get",
        ).mockImplementation(() => userHeight);
        vi.spyOn(
            HTMLElement.prototype,
            "getBoundingClientRect",
        ).mockImplementation(function (this: HTMLElement) {
            return {
                top: this.classList.contains("tr-chat-message-fades")
                    ? 200
                    : 1000,
                height: 96,
            } as DOMRect;
        });
        // offsetTop has a different origin from the scrolling viewport.
        vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(
            1200,
        );
        const { container } = render(
            <TRChatPanel
                reviewId="review-1"
                initialChatId="chat-1"
                onCitationClick={vi.fn()}
            />,
        );
        const viewport = container.querySelector<HTMLDivElement>(
            ".tr-chat-message-fades",
        )!;
        viewport.scrollTop = 200;
        viewport.scrollTo = vi.fn();
        Object.defineProperty(viewport, "clientHeight", { value: 700 });
        expect(viewport).toHaveStyle({ paddingTop: "80px" });
        const history: Awaited<ReturnType<typeof getTabularChatMessages>> = [
            {
                id: "m1",
                chat_id: "chat-1",
                role: "user",
                content: "First question",
                created_at: "2026-09-15T00:00:00Z",
            },
            {
                id: "m2",
                chat_id: "chat-1",
                role: "assistant",
                content: [{ type: "content", text: "First answer" }],
                created_at: "2026-09-15T00:00:01Z",
            },
            {
                id: "m3",
                chat_id: "chat-1",
                role: "user",
                content: "Latest question",
                created_at: "2026-09-15T00:00:02Z",
            },
            {
                id: "m4",
                chat_id: "chat-1",
                role: "assistant",
                content: [{ type: "content", text: "Latest answer" }],
                created_at: "2026-09-15T00:00:03Z",
            },
        ];
        await act(async () => resolveMessages(history));
        await waitFor(() =>
            expect(viewport.scrollTo).toHaveBeenCalledWith({
                top: 920,
                behavior: "auto",
            }),
        );
        expect(viewport.querySelector('[style*="min-height"]')).toHaveStyle({
            minHeight: "432px",
        });
        expect(screen.getByText("Latest question")).toBeVisible();

        userHeight = 120;
        vi.mocked(getTabularChatMessages).mockResolvedValueOnce(
            history.map((message) => ({ ...message, chat_id: "chat-2" })),
        );
        vi.mocked(viewport.scrollTo).mockClear();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Current draft" }));
        await user.click(
            screen.getByRole("menuitem", { name: /Earlier advice/ }),
        );
        await waitFor(() =>
            expect(viewport.scrollTo).toHaveBeenCalledWith({
                top: 920,
                behavior: "auto",
            }),
        );
        expect(viewport.querySelector('[style*="min-height"]')).toHaveStyle({
            minHeight: "372px",
        });
    });

    it("hides actions and the close button until a chat is active, with times instead of history row menus", async () => {
        const user = userEvent.setup();
        render(<TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
        expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
        await waitFor(() => expect(getTabularChats).toHaveBeenCalled());
        await user.click(screen.getByRole("button", { name: "New Chat" }));
        const row = await screen.findByRole("menuitem", {
            name: /Earlier advice/,
        });
        expect(within(row).getByText("2m")).toBeVisible();
        expect(within(row).queryByRole("button")).toBeNull();
        expect(screen.queryByTitle("Chat options")).toBeNull();

        await user.click(row);
        await waitFor(() =>
            expect(getTabularChatMessages).toHaveBeenCalledWith(
                "review-1",
                "chat-2",
            ),
        );
        expect(screen.getByRole("button", { name: "Actions" })).toBeVisible();
        expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
    });

    it("warns when an initial chat cannot be loaded", async () => {
        vi.mocked(getTabularChatMessages).mockRejectedValue(
            new Error("network unavailable"),
        );

        render(
            <TRChatPanel
                reviewId="review-1"
                initialChatId="chat-1"
                onCitationClick={vi.fn()}
            />,
        );

        expect(await screen.findByText("Chat unavailable")).toBeInTheDocument();
        expect(
            screen.getByText(
                "This chat’s messages could not be loaded. Please try again.",
            ),
        ).toBeInTheDocument();
    });

    it("opens the rejected-key popup for a tabular chat stream error", async () => {
        vi.mocked(streamTabularChat).mockResolvedValue(
            new Response(
                'data: {"type":"error","message":"The Anthropic (Claude) API key was rejected.","safe_to_display":true,"code":"invalid_api_key"}\n\ndata: [DONE]\n\n',
                { headers: { "Content-Type": "text/event-stream" } },
            ),
        );
        const user = userEvent.setup();

        const { container } = render(
            <TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} />,
        );
        const viewport = container.querySelector<HTMLDivElement>(
            ".tr-chat-message-fades",
        )!;
        viewport.scrollTo = vi.fn();
        await user.click(
            screen.getByRole("button", { name: "Send test message" }),
        );

        const alert = await screen.findByRole("alert");
        expect(within(alert).getByText("API key rejected")).toBeInTheDocument();
        expect(alert).toHaveTextContent(
            /The Anthropic \(Claude\) API key was rejected/,
        );
        expect(
            within(alert).getByRole("button", { name: "Go to settings" }),
        ).toBeInTheDocument();
    });

    it("shows loading in place of the icon and marks a detached completed chat green", async () => {
        const encoder = new TextEncoder();
        let streamController!: ReadableStreamDefaultController<Uint8Array>;
        vi.mocked(streamTabularChat).mockResolvedValue(
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        streamController = controller;
                    },
                }),
                { headers: { "Content-Type": "text/event-stream" } },
            ),
        );
        const user = userEvent.setup();
        const { container } = render(
            <TRChatPanel
                reviewId="review-1"
                initialChatId="chat-1"
                onCitationClick={vi.fn()}
            />,
        );
        container.querySelector<HTMLDivElement>(
            ".tr-chat-message-fades",
        )!.scrollTo = vi.fn();
        await screen.findByRole("button", { name: "Current draft" });

        await user.click(
            screen.getByRole("button", { name: "Send test message" }),
        );
        await user.click(screen.getByRole("button", { name: "Current draft" }));
        const loadingRow = screen.getByRole("menuitem", {
            name: /Current draft/,
        });
        expect(
            within(loadingRow).getByRole("status", {
                name: "Current draft response loading",
            }),
        ).toBeVisible();
        expect(loadingRow.querySelector("time")).not.toBeNull();

        await user.click(
            screen.getByRole("menuitem", { name: /Earlier advice/ }),
        );
        await waitFor(() =>
            expect(getTabularChatMessages).toHaveBeenCalledWith(
                "review-1",
                "chat-2",
            ),
        );
        act(() => {
            streamController.enqueue(
                encoder.encode(
                    'data: {"type":"content_delta","text":"Done"}\n\n',
                ),
            );
            streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
            streamController.close();
        });

        await user.click(
            screen.getByRole("button", { name: "Earlier advice" }),
        );
        const completedRow = await screen.findByRole("menuitem", {
            name: /Current draft/,
        });
        await waitFor(() =>
            expect(
                completedRow.querySelector("img[aria-hidden='true']"),
            ).toHaveClass("hue-rotate-[285deg]"),
        );
    });

    it("renames the active chat inline and keeps its actions beside New chat", async () => {
        const user = userEvent.setup();
        render(
            <TRChatPanel
                reviewId="review-1"
                initialChatId="chat-1"
                onCitationClick={vi.fn()}
            />,
        );
        await screen.findByRole("button", { name: "Current draft" });
        expect(
            screen.getByRole("button", { name: "Actions" }).parentElement,
        ).toBe(screen.getByRole("button", { name: "New chat" }).parentElement);
        await user.click(screen.getByRole("button", { name: "Actions" }));
        expect(screen.queryByRole("menuitem", { name: "Memory" })).toBeNull();
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));
        const input = screen.getByRole("textbox", { name: "Chat title" });
        await waitFor(() => expect(input).toHaveFocus());
        await user.clear(input);
        await user.type(input, "Updated advice{Enter}");
        await waitFor(() =>
            expect(renameTabularChat).toHaveBeenCalledExactlyOnceWith(
                "review-1",
                "chat-1",
                "Updated advice",
            ),
        );
        expect(
            screen.getByRole("button", { name: "Updated advice" }),
        ).toBeVisible();
    });

    it("hides actions when starting a new chat and retains the previous chat in history", async () => {
        const user = userEvent.setup();
        render(
            <TRChatPanel
                reviewId="review-1"
                initialChatId="chat-1"
                onCitationClick={vi.fn()}
            />,
        );
        await screen.findByRole("button", { name: "Current draft" });
        await user.click(screen.getByRole("button", { name: "New chat" }));
        expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "New Chat" }));
        expect(
            screen.getByRole("menuitem", { name: /Current draft/ }),
        ).toBeVisible();
        expect(deleteTabularChat).not.toHaveBeenCalled();
    });

    it("disables mutations in an active read-only chat", async () => {
        const user = userEvent.setup();
        render(
            <TRChatPanel
                reviewId="review-1"
                initialChatId="chat-1"
                canSend={false}
                onCitationClick={vi.fn()}
            />,
        );
        await screen.findByRole("button", { name: "Current draft" });
        expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Actions" }));
        for (const name of ["Rename", "Delete"]) {
            const item = screen.getByRole("menuitem", { name });
            expect(item).toHaveAttribute("aria-disabled", "true");
            await user.click(item);
        }
        expect(renameTabularChat).not.toHaveBeenCalled();
        expect(deleteTabularChat).not.toHaveBeenCalled();
    });

    it("deletes the active chat and hides its actions in the new chat view", async () => {
        const user = userEvent.setup();
        render(
            <TRChatPanel
                reviewId="review-1"
                initialChatId="chat-1"
                onCitationClick={vi.fn()}
            />,
        );
        await screen.findByRole("button", { name: "Current draft" });
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        expect(deleteTabularChat).toHaveBeenCalledExactlyOnceWith(
            "review-1",
            "chat-1",
        );
        expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
        expect(screen.getByRole("button", { name: "New Chat" })).toBeVisible();
    });
});

// ---------------------------------------------------------------------------
// The answer belongs to the server, not to this panel's socket: Stop is an
// endpoint, a dropped connection is rejoined, and a thread whose answer is
// already running attaches to it when it opens.
// ---------------------------------------------------------------------------

/** An SSE response the test feeds by hand. */
function controlledStream() {
    let push!: (line: string) => void;
    let close!: () => void;
    let fail!: (error: unknown) => void;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            push = (line) => controller.enqueue(encoder.encode(line));
            close = () => controller.close();
            fail = (error) => controller.error(error);
        },
    });
    return {
        response: new Response(body, {
            headers: { "Content-Type": "text/event-stream" },
        }),
        push,
        close,
        fail,
    };
}

/** jsdom has no scrollTo; the panel scrolls the latest user turn into view. */
function stubViewportScroll(container: HTMLElement) {
    const viewport = container.querySelector<HTMLDivElement>(
        ".tr-chat-message-fades",
    );
    if (viewport) viewport.scrollTo = vi.fn();
}

const sseResponse = (text: string) =>
    new Response(text, { headers: { "Content-Type": "text/event-stream" } });

describe("TRChatPanel server-owned turns", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                disconnect() {}
            },
        );
        vi.mocked(getTabularChats).mockResolvedValue([]);
        vi.mocked(getTabularChatMessages).mockResolvedValue([]);
        vi.mocked(stopTabularChatTurn).mockResolvedValue({
            stopped: true,
            finished: false,
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("reveals resumed history while chunks keep arriving faster than the positioning delay", async () => {
        vi.useFakeTimers();
        const stream = controlledStream();
        vi.mocked(getTabularChats).mockResolvedValue([{
            id: "chat-1",
            title: "Ongoing review",
            created_at: new Date().toISOString(),
            active_turn: { id: "turn-1", seq: 1, assistant_message_id: "answer-1" },
        }] as TRChat[]);
        vi.mocked(getTabularChatMessages).mockResolvedValue([
            { id: "q1", chat_id: "chat-1", role: "user", content: "Earlier question" },
            { id: "a1", chat_id: "chat-1", role: "assistant", content: [{ type: "content", text: "Earlier answer" }] },
            { id: "q2", chat_id: "chat-1", role: "user", content: "Still answering this question" },
        ] as Awaited<ReturnType<typeof getTabularChatMessages>>);
        vi.mocked(streamTabularChatTurn).mockResolvedValue(stream.response);
        const view = render(<TRChatPanel reviewId="review-1" initialChatId="chat-1" onCitationClick={vi.fn()} />);
        stubViewportScroll(view.container);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(streamTabularChatTurn).toHaveBeenCalledTimes(1);
        try {
            for (let i = 0; i < 50; i++) {
                await act(async () => {
                    stream.push(`data: ${JSON.stringify({ type: "content_delta", text: `Chunk ${i}. ` })}\n\n`);
                    await vi.advanceTimersByTimeAsync(20);
                });
            }
            // Waiting until DONE hides this starvation: every chunk used to
            // cancel and restart the 100ms timer, keeping loaded history blank.
            expect(view.container.querySelector(".transition-opacity")).toHaveStyle({ opacity: "1" });
            expect(screen.getByText(/Chunk 0/)).toBeInTheDocument();
        } finally {
            await act(async () => { stream.push("data: [DONE]\n\n"); stream.close(); });
            view.unmount();
        }
    });

    it("stops through the endpoint instead of dropping the connection", async () => {
        const stream = controlledStream();
        let sentSignal: AbortSignal | undefined;
        vi.mocked(streamTabularChat).mockImplementation(
            async (_reviewId, _messages, _chatId, signal) => {
                sentSignal = signal;
                return stream.response;
            },
        );
        const user = userEvent.setup();

        const { container } = render(
            <TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} />,
        );
        stubViewportScroll(container);
        await user.click(
            screen.getByRole("button", { name: "Send test message" }),
        );
        act(() => {
            stream.push(
                'id: 1\ndata: {"type":"chat_id","chatId":"chat-9","turnId":"turn-9"}\n\n',
            );
        });
        await waitFor(() => expect(sentSignal).toBeDefined());
        await act(async () => {
            await Promise.resolve();
        });

        await user.click(
            screen.getByRole("button", { name: "Stop test message" }),
        );

        await waitFor(() =>
            expect(stopTabularChatTurn).toHaveBeenCalledExactlyOnceWith(
                "review-1",
                "chat-9",
                "turn-9",
            ),
        );
        // Dropping the socket would only detach this panel while the server
        // kept answering into the transcript.
        expect(sentSignal?.aborted).toBe(false);

        act(() => {
            stream.push('id: 2\ndata: {"type":"cancelled"}\n\n');
            stream.push("data: [DONE]\n\n");
            stream.close();
        });
    });

    it("rejoins the turn from the last frame it applied when the connection drops", async () => {
        const stream = controlledStream();
        vi.mocked(streamTabularChat).mockResolvedValue(stream.response);
        vi.mocked(streamTabularChatTurn).mockResolvedValue(
            sseResponse(
                'id: 3\ndata: {"type":"content_delta","text":" and the rest"}\n\ndata: [DONE]\n\n',
            ),
        );
        const user = userEvent.setup();

        const { container } = render(
            <TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} />,
        );
        stubViewportScroll(container);
        await user.click(
            screen.getByRole("button", { name: "Send test message" }),
        );
        act(() => {
            stream.push(
                'id: 1\ndata: {"type":"chat_id","chatId":"chat-9","turnId":"turn-9"}\n\n',
            );
            stream.push(
                'id: 2\ndata: {"type":"content_delta","text":"Half an answer"}\n\n',
            );
        });
        await waitFor(() =>
            expect(screen.getByText(/Half an answer/)).toBeInTheDocument(),
        );

        act(() => stream.fail(new TypeError("network error")));

        await waitFor(
            () =>
                expect(streamTabularChatTurn).toHaveBeenCalledWith({
                    reviewId: "review-1",
                    chatId: "chat-9",
                    turnId: "turn-9",
                    from: 3,
                    signal: expect.anything(),
                }),
            { timeout: 3_000 },
        );
        await waitFor(() =>
            expect(
                screen.getByText(/Half an answer and the rest/),
            ).toBeInTheDocument(),
        );
    });

    it("attaches to a thread whose answer is still being generated when it opens", async () => {
        vi.mocked(getTabularChats).mockResolvedValue([
            {
                id: "chat-1",
                title: "Current draft",
                created_at: new Date().toISOString(),
                active_turn: {
                    id: "turn-7",
                    seq: 2,
                    assistant_message_id: "m-7",
                },
            },
        ] as TRChat[]);
        vi.mocked(getTabularChatMessages).mockResolvedValue([
            {
                id: "m-1",
                chat_id: "chat-1",
                role: "user",
                content: "Summarise the table",
                created_at: new Date().toISOString(),
            },
        ] as Awaited<ReturnType<typeof getTabularChatMessages>>);
        vi.mocked(streamTabularChatTurn).mockResolvedValue(
            sseResponse(
                'id: 1\ndata: {"type":"content_delta","text":"Still answering"}\n\ndata: [DONE]\n\n',
            ),
        );

        const { container } = render(
            <TRChatPanel
                reviewId="review-1"
                initialChatId="chat-1"
                onCitationClick={vi.fn()}
            />,
        );
        stubViewportScroll(container);

        await waitFor(() =>
            expect(streamTabularChatTurn).toHaveBeenCalledExactlyOnceWith({
                reviewId: "review-1",
                chatId: "chat-1",
                turnId: "turn-7",
                from: 1,
                signal: expect.anything(),
            }),
        );
        // The stored transcript has the user turn only; the answer arrives as
        // a streaming placeholder appended after it.
        expect(
            await screen.findByText(/Still answering/, undefined, {
                timeout: 3_000,
            }),
        ).toBeInTheDocument();
        expect(streamTabularChat).not.toHaveBeenCalled();
    });
});

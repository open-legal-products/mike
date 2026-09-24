import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    deleteTabularChat,
    getTabularChats,
    getTabularChatMessages,
    renameTabularChat,
    streamTabularChat,
    type TRChat,
} from "@/app/lib/mikeApi";
import { TRChatPanel } from "./TRChatPanel";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

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
}));
vi.mock("../assistant/ChatInput", () => ({
    ChatInput: ({
        onSubmit,
        canSend = true,
    }: {
        onSubmit: (message: {
            role: "user";
            content: string;
            model: string;
            reasoning: "medium";
        }) => void;
        canSend?: boolean;
    }) => (
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
    ),
}));

describe("TRChatPanel header", () => {
    beforeEach(() => {
        clearToasts();
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
        clearToasts();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
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

    it("puts the chat back and explains when deleting it fails", async () => {
        const user = userEvent.setup();
        vi.mocked(deleteTabularChat).mockRejectedValue(new Error("boom"));
        render(
            <>
                <TRChatPanel
                    reviewId="review-1"
                    initialChatId="chat-1"
                    onCitationClick={vi.fn()}
                />
                <ToastViewportUI />
            </>,
        );
        await screen.findByRole("button", { name: "Current draft" });
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't delete this chat");
        // The optimistic removal is undone: the thread is open again.
        expect(
            await screen.findByRole("button", { name: "Current draft" }),
        ).toBeVisible();
        expect(
            within(alert).getByRole("button", { name: "Retry" }),
        ).toBeVisible();
    });

    it("does not reopen the deleted thread over one the user opened since", async () => {
        const user = userEvent.setup();
        let failDelete!: (error: unknown) => void;
        vi.mocked(deleteTabularChat).mockReturnValue(
            new Promise((_resolve, reject) => {
                failDelete = reject;
            }),
        );
        render(
            <>
                <TRChatPanel
                    reviewId="review-1"
                    initialChatId="chat-1"
                    onCitationClick={vi.fn()}
                />
                <ToastViewportUI />
            </>,
        );
        await screen.findByRole("button", { name: "Current draft" });
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));

        // While the delete is in flight the user opens another thread.
        await user.click(screen.getByRole("button", { name: /New Chat/ }));
        await user.click(
            await screen.findByRole("menuitem", { name: /Earlier advice/ }),
        );
        await screen.findByRole("button", { name: /Earlier advice/ });

        await act(async () => {
            failDelete(new Error("boom"));
            await Promise.resolve();
        });

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Couldn't delete this chat",
        );
        // The thread the user is reading stays open...
        expect(
            screen.getByRole("button", { name: /Earlier advice/ }),
        ).toBeVisible();
        // ...and the chat that failed to delete is back in the history.
        await user.click(
            screen.getByRole("button", { name: /Earlier advice/ }),
        );
        expect(
            await screen.findByRole("menuitem", { name: /Current draft/ }),
        ).toBeVisible();
    });

    it("restores the old title and explains when renaming fails", async () => {
        const user = userEvent.setup();
        vi.mocked(renameTabularChat).mockRejectedValue(new Error("boom"));
        render(
            <>
                <TRChatPanel
                    reviewId="review-1"
                    initialChatId="chat-1"
                    onCitationClick={vi.fn()}
                />
                <ToastViewportUI />
            </>,
        );
        await screen.findByRole("button", { name: "Current draft" });
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));
        const input = await screen.findByRole("textbox");
        await user.clear(input);
        await user.type(input, "Renamed thread{Enter}");

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't rename this chat");
        expect(
            await screen.findByRole("button", { name: "Current draft" }),
        ).toBeVisible();
    });

    it("reports a chat history that could not be loaded", async () => {
        vi.mocked(getTabularChats).mockRejectedValue(new Error("boom"));
        render(
            <>
                <TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} />
                <ToastViewportUI />
            </>,
        );
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't load your chat history");
        expect(
            within(alert).getByRole("button", { name: "Retry" }),
        ).toBeVisible();
    });

    it("reports a transcript that could not be loaded instead of showing an empty chat", async () => {
        vi.mocked(getTabularChatMessages).mockRejectedValue(new Error("boom"));
        render(
            <>
                <TRChatPanel
                    reviewId="review-1"
                    initialChatId="chat-1"
                    onCitationClick={vi.fn()}
                />
                <ToastViewportUI />
            </>,
        );
        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't load this chat");
    });
});

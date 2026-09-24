import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    getTabularChats,
    getTabularChatMessages,
    streamTabularChat,
} from "@/app/lib/mikeApi";
import type { Message } from "@/app/components/shared/types";
import { TRChatPanel } from "./TRChatPanel";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getTabularChats: vi.fn(),
    getTabularChatMessages: vi.fn(),
    streamTabularChat: vi.fn(),
}));

// A stub composer so a test can send the question without driving the real
// model pickers.
vi.mock("../assistant/ChatInput", () => ({
    ChatInput: ({ onSubmit }: { onSubmit: (message: Message) => void }) => (
        <button
            type="button"
            onClick={() =>
                onSubmit({
                    role: "user",
                    content: "What does clause 4 say?",
                    model: "claude-sonnet-5",
                    reasoning: "high",
                } as Message)
            }
        >
            Ask
        </button>
    ),
}));

/** A real SSE body: the server writes an error frame and then `[DONE]`. */
function sseResponse(frames: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) {
                controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
}

describe("TRChatPanel terminal error frame", () => {
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
        HTMLElement.prototype.scrollTo = vi.fn();
        vi.mocked(getTabularChats).mockResolvedValue([]);
        vi.mocked(getTabularChatMessages).mockResolvedValue([]);
    });

    afterEach(() => {
        clearToasts();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("keeps the partial answer, marks the turn failed and offers a Retry that resends the question", async () => {
        // Without the error-frame branch the panel ignores this frame: the
        // answer stops mid-sentence and reads as a finished reply.
        vi.mocked(streamTabularChat).mockImplementation(async () =>
            sseResponse([
                JSON.stringify({ type: "chat_id", chatId: "chat-9" }),
                JSON.stringify({
                    type: "content_delta",
                    text: "Clause 4 says",
                }),
                JSON.stringify({
                    type: "error",
                    message: "Model provider exploded: trace 0xdeadbeef",
                }),
            ]),
        );
        const user = userEvent.setup();
        render(
            <>
                <TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} />
                <ToastViewportUI />
            </>,
        );

        await user.click(await screen.findByRole("button", { name: "Ask" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't get a response");
        // The server's own wording is internal: it is never shown.
        expect(alert).not.toHaveTextContent("0xdeadbeef");
        expect(alert).toHaveTextContent(
            "Mike couldn't finish this answer. Try again.",
        );

        // What already streamed is kept, and the bubble says the turn failed.
        expect(await screen.findByText(/Clause 4 says/)).toBeVisible();
        expect(
            screen.getByText("Mike couldn't finish this answer. Try again.", {
                selector: "p",
            }),
        ).toBeVisible();

        // Retry rewinds the transcript and re-sends the same question.
        vi.mocked(streamTabularChat).mockClear();
        vi.mocked(streamTabularChat).mockImplementation(async () =>
            sseResponse([
                JSON.stringify({
                    type: "content_delta",
                    text: "Clause 4 says the tenant pays.",
                }),
            ]),
        );
        await user.click(within(alert).getByRole("button", { name: "Retry" }));

        await waitFor(() => expect(streamTabularChat).toHaveBeenCalledTimes(1));
        const [, resentMessages, resentChatId] = vi.mocked(streamTabularChat).mock.calls[0];
        expect(resentChatId).toBe("chat-9");
        expect(resentMessages).toEqual([
            { role: "user", content: "What does clause 4 say?" },
        ]);
        expect(screen.getAllByText("What does clause 4 say?")).toHaveLength(1);
    });

    it("does not resend an old toast after its panel unmounts", async () => {
        vi.mocked(streamTabularChat).mockResolvedValue(sseResponse([
            JSON.stringify({ type: "chat_id", chatId: "chat-9" }),
            JSON.stringify({ type: "error", message: "failed" }),
        ]));
        const user = userEvent.setup();
        const { rerender } = render(<><TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} /><ToastViewportUI /></>);
        await user.click(await screen.findByRole("button", { name: "Ask" }));
        await screen.findByRole("alert");
        rerender(<ToastViewportUI />);
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(streamTabularChat).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("status")).toHaveTextContent("This chat has changed");
    });

    it("shows a configuration refusal verbatim and offers no Retry", async () => {
        vi.mocked(streamTabularChat).mockImplementation(async () =>
            sseResponse([
                JSON.stringify({
                    type: "error",
                    message: "Add an Anthropic API key in Settings to use this model.",
                    safe_to_display: true,
                }),
            ]),
        );
        const user = userEvent.setup();
        render(
            <>
                <TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} />
                <ToastViewportUI />
            </>,
        );

        await user.click(await screen.findByRole("button", { name: "Ask" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(
            "Add an Anthropic API key in Settings to use this model.",
        );
        // Re-sending the same question cannot change a refusal like this.
        expect(
            within(alert).queryByRole("button", { name: "Retry" }),
        ).not.toBeInTheDocument();
    });
});

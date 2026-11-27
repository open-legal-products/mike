import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    getTabularChats,
    getTabularChatMessages,
    streamTabularChat,
} from "@/app/lib/mikeApi";
import type { Message } from "@/app/components/shared/types";
import { TRChatPanel } from "./TRChatPanel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getTabularChats: vi.fn(),
    getTabularChatMessages: vi.fn(),
    streamTabularChat: vi.fn(),
    streamTabularChatTurn: vi.fn(),
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

/** A real SSE body: the given frames, then `[DONE]`. */
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

describe("TRChatPanel citations", () => {
    beforeEach(() => {
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
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([{ type: "cancelled" }, { type: "error", message: "Interrupted" }])(
        "finishes an outstanding recording step on $type", async terminal => {
            vi.mocked(streamTabularChat).mockImplementation(async () => sseResponse([
                JSON.stringify({ type: "chat_id", chatId: "chat-9" }),
                JSON.stringify({ type: "citations_recorded_start" }),
                JSON.stringify(terminal),
            ]));
            const user = userEvent.setup();
            render(<TRChatPanel reviewId="review-1" onCitationClick={vi.fn()} />);
            await user.click(await screen.findByRole("button", { name: "Ask" }));
            const toggle = await screen.findByRole("button", { name: /step/i });
            if (!screen.queryByText("Citation recording stopped")) await user.click(toggle);
            expect(await screen.findByText("Citation recording stopped")).toBeVisible();
            expect(screen.queryByText("Recording citations...")).toBeNull();
        },
    );

    it("shows the recorded citations as a step whose source opens the cited cell", async () => {
        const cell = {
            type: "tabular_citation",
            ref: 1,
            col_index: 0,
            row_index: 2,
            col_name: "Rent",
            doc_name: "Lease A.pdf",
            quote: "Rent is $5,000 per month",
            verified: true,
        };
        vi.mocked(streamTabularChat).mockImplementation(async () =>
            sseResponse([
                JSON.stringify({ type: "chat_id", chatId: "chat-9" }),
                JSON.stringify({ type: "citations_recorded_start" }),
                JSON.stringify({
                    type: "citations_recorded",
                    refs: [1],
                    sources: [{ name: "Lease A.pdf", type: "pdf", ref: 1 }],
                    quotes_not_found: 0,
                    rejected: 0,
                }),
                JSON.stringify({ type: "citations", status: "partial", citations: [cell] }),
                JSON.stringify({ type: "content_delta", text: "Rent is $5,000 a month [1]." }),
                JSON.stringify({ type: "citations", status: "final", citations: [cell] }),
            ]),
        );
        const onCitationClick = vi.fn();
        const user = userEvent.setup();
        render(<TRChatPanel reviewId="review-1" onCitationClick={onCitationClick} />);

        await user.click(await screen.findByRole("button", { name: "Ask" }));
        await screen.findByText(/Rent is \$5,000 a month/);

        // Like every step, it folds away once the answer is written.
        await user.click(screen.getByRole("button", { name: /1 step/ }));
        expect(screen.getByText("Recorded 1 citation from")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Lease A.pdf" }));
        expect(onCitationClick).toHaveBeenCalledExactlyOnceWith(0, 2);
    });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

const { createChat, listChats } = vi.hoisted(() => ({
    createChat: vi.fn(),
    listChats: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    createChat: (...args: unknown[]) => createChat(...args),
    listChats: (...args: unknown[]) => listChats(...args),
    renameChat: vi.fn(async () => undefined),
    deleteChat: vi.fn(async () => undefined),
}));

// One stable user object: a fresh one per render would restart the loader.
const STABLE_USER = { id: "u1", email: "a@firm.test" };
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: STABLE_USER }),
}));

import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";

const retrySpy = vi.fn();

function Probe() {
    const { chats, hasMoreChats, loadMoreChats, saveChat } =
        useChatHistoryContext();
    return (
        <div>
            <button onClick={() => void loadMoreChats()}>more</button>
            <button onClick={() => void saveChat()}>save</button>
            <button
                onClick={() =>
                    void saveChat(undefined, undefined, { onRetry: retrySpy })
                }
            >
                save-with-retry
            </button>
            <span data-testid="count">{chats?.length ?? "null"}</span>
            <span data-testid="has-more">{String(hasMoreChats)}</span>
        </div>
    );
}

function renderProvider() {
    return render(
        <>
            <ChatHistoryProvider>
                <Probe />
            </ChatHistoryProvider>
            <ToastViewportUI />
        </>,
    );
}

beforeEach(() => {
    vi.resetAllMocks();
    clearToasts();
    createChat.mockResolvedValue({ id: "chat-9" });
    listChats.mockResolvedValue([]);
});

afterEach(() => {
    clearToasts();
});

describe("ChatHistoryProvider failures", () => {
    // The old bare catch set an empty list, which is how "no chats yet"
    // looks: a failed history load was indistinguishable from a new account.
    it("tells the user when the chat list cannot be loaded", async () => {
        listChats.mockRejectedValue(new Error("boom"));

        renderProvider();

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Couldn't load your chats",
            ),
        );
    });

    it("retries the chat list from the toast", async () => {
        listChats.mockRejectedValueOnce(new Error("boom"));

        renderProvider();

        await waitFor(() => screen.getByRole("alert"));
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() => expect(listChats).toHaveBeenCalledTimes(2));
    });

    it("keeps the loaded page and reports a failed next page", async () => {
        listChats.mockResolvedValueOnce(
            Array.from({ length: 21 }, (_, index) => ({ id: `c${index}`, updated_at: "2026-09-23T00:00:00Z" })),
        );

        renderProvider();
        await waitFor(() =>
            expect(screen.getByTestId("has-more")).toHaveTextContent("true"),
        );

        listChats.mockRejectedValueOnce(new Error("boom"));
        fireEvent.click(screen.getByRole("button", { name: "more" }));

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Couldn't load more chats",
            ),
        );
        // The page already on screen is untouched.
        expect(screen.getByTestId("count")).toHaveTextContent("20");
    });

    it("offers Retry only when the caller can re-run its submit", async () => {
        createChat.mockRejectedValue(new Error("boom"));

        renderProvider();
        await waitFor(() => expect(listChats).toHaveBeenCalled());

        fireEvent.click(screen.getByRole("button", { name: "save" }));
        await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

        fireEvent.click(
            screen.getByRole("button", { name: "Dismiss notification" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "save-with-retry" }),
        );
        const retry = await screen.findByRole("button", { name: "Retry" });
        fireEvent.click(retry);
        expect(retrySpy).toHaveBeenCalledOnce();
    });

    it("tells the user when a new chat cannot be created", async () => {
        createChat.mockRejectedValue(new Error("boom"));

        renderProvider();
        await waitFor(() => expect(listChats).toHaveBeenCalled());

        fireEvent.click(screen.getByRole("button", { name: "save" }));

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Couldn't start a new chat",
            ),
        );
    });
});

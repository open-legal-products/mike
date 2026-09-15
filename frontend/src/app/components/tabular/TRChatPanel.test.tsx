import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    deleteTabularChat,
    getTabularChats,
    getTabularChatMessages,
    renameTabularChat,
    type TRChat,
} from "@/app/lib/mikeApi";
import { TRChatPanel } from "./TRChatPanel";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getTabularChats: vi.fn(),
    getTabularChatMessages: vi.fn(),
    deleteTabularChat: vi.fn(),
    renameTabularChat: vi.fn(),
}));
vi.mock("../assistant/ChatInput", () => ({
    ChatInput: () => <div>Chat input</div>,
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
    afterEach(() => vi.unstubAllGlobals());

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

import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Chat } from "@/app/components/shared/types";
import { ProjectAssistantTable } from "./ProjectAssistantTable";

// Owner rows: deleting is `container.delete`, which the table now checks
// before it offers the confirmation, so a row with no served role would be
// refused here rather than reaching the handler.
const chats: Chat[] = [
    {
        id: "chat-1",
        project_id: "project-1",
        user_id: "user-1",
        title: "First chat",
        created_at: "2026-08-27T00:00:00.000Z",
        access_role: "owner",
    },
    {
        id: "chat-2",
        project_id: "project-1",
        user_id: "user-1",
        title: "Second chat",
        created_at: "2026-08-27T00:00:00.000Z",
        access_role: "owner",
    },
];

function renderTable(selectedChatIds: string[], canCreateChat = true, rows = chats) {
    const onCreateChat = vi.fn();
    const onDeleteChat = vi.fn();
    const onDeleteSelectedChats = vi.fn();
    const onOpenChat = vi.fn();
    const setSelectedChatIds = vi.fn();
    function Harness() {
        const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
        const [renameChatValue, setRenameChatValue] = useState("");
        return <ProjectAssistantTable
            renderToolbar={(actions) => <>{actions}</>}
            canCreateChat={canCreateChat}
            chats={rows}
            filteredChats={rows}
            selectedChatIds={selectedChatIds}
            renamingChatId={renamingChatId}
            renameChatValue={renameChatValue}
            currentUserId="user-1"
            onCreateChat={onCreateChat}
            onOpenChat={onOpenChat}
            onDeleteChat={onDeleteChat}
            onDeleteSelectedChats={onDeleteSelectedChats}
            onOwnerOnlyAction={vi.fn()}
            submitChatRename={vi.fn()}
            setSelectedChatIds={setSelectedChatIds}
            setRenamingChatId={setRenamingChatId}
            setRenameChatValue={setRenameChatValue}
        />;
    }
    render(<Harness />);
    return {
        onCreateChat,
        onDeleteChat,
        onDeleteSelectedChats,
        onOpenChat,
        setSelectedChatIds,
    };
}

describe("ProjectAssistantTable row context actions", () => {
    it.each([1, 2])("matches toolbar and right-click actions for %i selected chats", async (count) => {
        const user = userEvent.setup();
        renderTable(chats.slice(0, count).map((chat) => chat.id));
        await user.click(screen.getByRole("button", { name: "Actions" }));
        const toolbarItems = screen.getAllByRole("menuitem").map((item) => item.textContent);
        expect(toolbarItems).toEqual(count === 1 ? ["View", "Rename", "Delete"] : ["Delete 2 chats"]);
        await user.keyboard("{Escape}");
        fireEvent.contextMenu(screen.getByText("First chat"));
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(toolbarItems);
    });

    it("keeps focus in the rename field after a toolbar action", async () => {
        const user = userEvent.setup();
        renderTable(["chat-1"]);
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));
        const input = screen.getByDisplayValue("First chat");
        expect(input).toHaveFocus();
        await user.type(input, " renamed");
        expect(input).toHaveValue("First chat renamed");
    });

    it("confirms a single toolbar delete before invoking the handler", async () => {
        const user = userEvent.setup();
        const { onDeleteChat, onDeleteSelectedChats } = renderTable(["chat-1"]);
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        expect(onDeleteChat).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(onDeleteChat).toHaveBeenCalledWith(chats[0]);
        expect(onDeleteSelectedChats).not.toHaveBeenCalled();
    });

    it.each([false, true])("gates empty-state Create on resolved edit permission (%s)", (allowed) => {
        const { onCreateChat } = renderTable([], allowed, []);
        const button = screen.getByRole("button", { name: "Create" });
        if (allowed) expect(button).toBeEnabled();
        else expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(onCreateChat).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });
    it.each(["right-click", "toolbar"])("deletes the whole selection from the %s menu", async (surface) => {
        const user = userEvent.setup();
        const { onDeleteChat, onDeleteSelectedChats } = renderTable([
            "chat-1",
            "chat-2",
        ]);

        if (surface === "toolbar")
            await user.click(screen.getByRole("button", { name: "Actions" }));
        else fireEvent.contextMenu(screen.getByText("First chat"));
        expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "View" })).toBeNull();
        await user.click(screen.getByRole("menuitem", { name: "Delete 2 chats" }));

        expect(onDeleteSelectedChats).toHaveBeenCalledOnce();
        expect(onDeleteChat).not.toHaveBeenCalled();
    });

    it("targets only an unselected row", async () => {
        const user = userEvent.setup();
        const { onDeleteChat, onDeleteSelectedChats } = renderTable(["chat-2"]);

        fireEvent.contextMenu(screen.getByText("First chat"));
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));
        // The single-row delete is confirmed first; the bulk one is confirmed
        // by the page that owns the selection.
        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(onDeleteChat).toHaveBeenCalledWith(chats[0]);
        expect(onDeleteSelectedChats).not.toHaveBeenCalled();
    });

    it("views a single row from its right-click menu", async () => {
        const user = userEvent.setup();
        const { onOpenChat } = renderTable([]);

        fireEvent.contextMenu(screen.getByText("First chat"));
        await user.click(screen.getByRole("menuitem", { name: "View" }));

        expect(onOpenChat).toHaveBeenCalledWith("chat-1");
    });

    it("opens on click and adds one row on command/control-click", () => {
        const { onOpenChat, setSelectedChatIds } = renderTable(["chat-2"]);
        const rowLabel = screen.getByText("First chat");

        fireEvent.click(rowLabel);
        expect(onOpenChat).toHaveBeenCalledWith("chat-1");
        expect(setSelectedChatIds).not.toHaveBeenCalled();

        for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
            onOpenChat.mockClear();
            setSelectedChatIds.mockClear();
            fireEvent.click(rowLabel, modifier);
            const update = setSelectedChatIds.mock.calls[0]?.[0] as (
                current: string[],
            ) => string[];

            expect(update(["chat-2"])).toEqual(["chat-2", "chat-1"]);
        }
        expect(onOpenChat).not.toHaveBeenCalled();
    });

    it("selects the inclusive range between shift-clicked rows", () => {
        const { onOpenChat, setSelectedChatIds } = renderTable([]);

        fireEvent.click(screen.getByText("First chat"), { shiftKey: true });
        fireEvent.click(screen.getByText("Second chat"), { shiftKey: true });

        const firstUpdate = setSelectedChatIds.mock.calls[0]?.[0] as (
            current: string[],
        ) => string[];
        const secondUpdate = setSelectedChatIds.mock.calls[1]?.[0] as (
            current: string[],
        ) => string[];
        const firstSelection = firstUpdate([]);

        expect(firstSelection).toEqual(["chat-1"]);
        expect(secondUpdate(firstSelection)).toEqual(["chat-1", "chat-2"]);
        expect(onOpenChat).not.toHaveBeenCalled();
    });
});

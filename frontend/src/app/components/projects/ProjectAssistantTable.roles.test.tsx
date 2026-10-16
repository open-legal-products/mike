import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Chat } from "@/app/components/shared/types";
import { ProjectAssistantTable } from "./ProjectAssistantTable";

// Managing chat titles and deletion is owner-only, regardless of authorship.

const onOwnerOnlyAction = vi.fn();
const setRenamingChatId = vi.fn();
const setRenameChatValue = vi.fn();
const onDeleteChat = vi.fn();

function chat(overrides: Partial<Chat> = {}): Chat {
    return {
        id: "c1",
        project_id: "p1",
        user_id: "u2",
        title: "Deposition prep",
        created_at: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

function renderTable(row: Chat) {
    const chats = [row];
    return render(
        <ProjectAssistantTable
            canCreateChat={true}
            chats={chats}
            filteredChats={chats}
            selectedChatIds={[]}
            renamingChatId={null}
            renameChatValue=""
            currentUserId="u1"
            onCreateChat={vi.fn()}
            onOpenChat={vi.fn()}
            onDeleteChat={onDeleteChat}
            onDeleteSelectedChats={vi.fn()}
            onOwnerOnlyAction={onOwnerOnlyAction}
            submitChatRename={vi.fn()}
            setSelectedChatIds={vi.fn()}
            setRenamingChatId={setRenamingChatId}
            setRenameChatValue={setRenameChatValue}
        />,
    );
}

/** Open the row's action menu and click Rename. */
function clickRename() {
    fireEvent.pointerDown(
        screen.getByText("···"),
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(screen.getByText("Rename"));
}

/** Open the row's action menu and click Delete. */
function clickDelete() {
    fireEvent.pointerDown(
        screen.getByText("···"),
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(screen.getByText("Delete"));
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("ProjectAssistantTable rename gating", () => {
    it("lets a project admin rename a colleague's chat", () => {
        renderTable(chat({ access_role: "owner", is_owner: false }));

        clickRename();

        expect(setRenamingChatId).toHaveBeenCalledWith("c1");
        expect(onOwnerOnlyAction).not.toHaveBeenCalled();
    });

    it.each(["editor", "viewer"] as const)("hides Rename for a %s", (role) => {
        renderTable(chat({ access_role: role, is_owner: false }));
        fireEvent.pointerDown(screen.getByText("···"), new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
        expect(screen.queryByText("Rename")).toBeNull();
        expect(setRenamingChatId).not.toHaveBeenCalled();
    });

});

describe("ProjectAssistantTable delete confirmation", () => {
    it("asks before deleting a colleague's chat", () => {
        // One click used to be the whole interaction: the row was gone, and
        // the chat with it, with nothing between the menu and the request.
        renderTable(chat({ access_role: "owner", is_owner: false }));

        clickDelete();

        expect(onDeleteChat).not.toHaveBeenCalled();
        expect(screen.getByText("Delete chat?")).toBeInTheDocument();
        expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Delete" }));

        expect(onDeleteChat).toHaveBeenCalledTimes(1);
        expect(onDeleteChat.mock.calls[0][0]).toMatchObject({ id: "c1" });
    });

    it("deletes nothing when the confirmation is cancelled", () => {
        renderTable(chat({ access_role: "owner", is_owner: false }));

        clickDelete();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.queryByText("Delete chat?")).not.toBeInTheDocument();
        expect(onDeleteChat).not.toHaveBeenCalled();
    });

    it("hides Delete for an editor", () => {
        renderTable(chat({ access_role: "editor", is_owner: false }));
        fireEvent.pointerDown(screen.getByText("···"), new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
        expect(screen.queryByText("Delete")).toBeNull();
        expect(onDeleteChat).not.toHaveBeenCalled();
    });
});

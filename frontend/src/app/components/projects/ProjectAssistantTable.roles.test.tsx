import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Chat } from "@/app/components/shared/types";
import { ProjectAssistantTable } from "./ProjectAssistantTable";

// Renaming a chat is `content.edit` — member and above — on the role the
// SERVER served for that chat. The gate here used to be
// `chat.user_id !== currentUserId`, which refused a project admin their
// colleague's chat and offered the rename to a viewer who happened to have
// started the thread... which is right, but only by accident: the creator
// branch derives admin, and that is where the right comes from.

const onOwnerOnlyAction = vi.fn();
const setRenamingChatId = vi.fn();
const setRenameChatValue = vi.fn();

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
            chats={chats}
            filteredChats={chats}
            selectedChatIds={[]}
            renamingChatId={null}
            renameChatValue=""
            currentUserId="u1"
            onCreateChat={vi.fn()}
            onOpenChat={vi.fn()}
            onDeleteChat={vi.fn()}
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
    fireEvent.click(screen.getByText("···"));
    fireEvent.click(screen.getByText("Rename"));
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

    it("lets a member rename it too — content collaboration is member-tier", () => {
        renderTable(chat({ access_role: "editor", is_owner: false }));

        clickRename();

        expect(setRenamingChatId).toHaveBeenCalledWith("c1");
    });

    it("refuses a viewer, naming the role the action needs", () => {
        renderTable(chat({ access_role: "viewer", is_owner: false }));

        clickRename();

        expect(setRenamingChatId).not.toHaveBeenCalled();
        // "editor", not "owner": the popup tells the viewer which tier they
        // would have to be, and renaming does not need an admin.
        expect(onOwnerOnlyAction).toHaveBeenCalledWith({
            action: "rename this chat",
            requiredRole: "editor",
        });
    });
});

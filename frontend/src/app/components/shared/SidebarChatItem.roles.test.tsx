import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarChatItem } from "./SidebarChatItem";
import type { Chat } from "@/app/components/shared/types";

// Chat management is owner-only; direct recipients may leave.

const renameChat = vi.fn();
const deleteChat = vi.fn();
const leaveChat = vi.fn();
const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ renameChat, deleteChat, leaveChat }),
}));
vi.mock("@/app/components/assistant/ChatAccessModal", () => ({
    ChatAccessModal: ({ open }: { open: boolean }) =>
        open ? <div>Chat access modal</div> : null,
}));

function chat(overrides: Partial<Chat>): Chat {
    return {
        id: "chat-1",
        project_id: null,
        title: "Quarterly filing",
        user_id: "someone-else",
        created_at: new Date().toISOString(),
        ...overrides,
    } as Chat;
}

function openMenu() {
    // Radix opens on pointerdown, not click.
    const trigger = screen.getByRole("button", {
        name: "Actions for Quarterly filing",
    });
    fireEvent.pointerDown(
        trigger,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(trigger);
}

beforeEach(() => {
    vi.clearAllMocks();
    deleteChat.mockResolvedValue(undefined);
    leaveChat.mockResolvedValue(undefined);
});

describe("SidebarChatItem role gates", () => {
    it("opens chat access from an owner's Share action", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Share"));

        expect(await screen.findByText("Chat access modal")).toBeInTheDocument();
    });

    it.each(["viewer", "editor"] as const)("hides owner actions and lets a shared %s leave", async (role) => {
        render(<SidebarChatItem chat={chat({ is_owner: false, access_role: role, can_leave: true })} isActive onSelect={vi.fn()} />);
        openMenu();
        expect(await screen.findByRole("menuitem", { name: "Leave" })).toBeVisible();
        for (const name of ["Share", "Rename", "Delete"]) {
            expect(screen.queryByRole("menuitem", { name })).toBeNull();
        }
        fireEvent.click(screen.getByRole("menuitem", { name: "Leave" }));
        expect(leaveChat).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Leave" }));
        await waitFor(() => expect(leaveChat).toHaveBeenCalledWith("chat-1"));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(deleteChat).not.toHaveBeenCalled();
    });

    it.each([
        { project_id: "project-1", can_leave: true },
        { project_id: null, can_leave: false },
    ])("does not offer Leave for project or audited access: %j", (access) => {
        render(<SidebarChatItem chat={chat({ ...access, access_role: "viewer" })} isActive onSelect={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Actions for Quarterly filing" })).toBeNull();
    });

    it("shows a failed leave without deleting or navigating", async () => {
        leaveChat.mockRejectedValue(new Error("internal database details"));
        render(<SidebarChatItem chat={chat({ can_leave: true, access_role: "viewer" })} isActive onSelect={vi.fn()} />);
        openMenu();
        fireEvent.click(await screen.findByRole("menuitem", { name: "Leave" }));
        fireEvent.click(screen.getByRole("button", { name: "Leave" }));
        expect(await screen.findByText("The chat could not be left. Please try again.")).toBeVisible();
        expect(screen.queryByText("internal database details")).toBeNull();
        expect(deleteChat).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });

    it("lets the creator delete — is_owner alone derives admin", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(deleteChat).toHaveBeenCalledWith("chat-1");
    });

    it("lets a project admin delete a colleague's chat", async () => {
        // The exact shape the overview RPC serves an org/project admin for a
        // thread they did not start: is_owner false, access_role "owner".
        // Before the RPC served access_role, this row fell back to "editor"
        // and the admin was refused a delete the server accepts — the
        // headline widening, unreachable from the sidebar.
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "owner" })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(deleteChat).toHaveBeenCalledWith("chat-1");
    });

    it("hides management and Leave when role metadata is missing", () => {
        render(<SidebarChatItem chat={chat({})} isActive onSelect={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Actions for Quarterly filing" })).toBeNull();
    });

    it("surfaces a failed rename instead of a silent revert", async () => {
        // The context reloads the list on failure, snapping the title back.
        // Without a popup the user just watches their edit undo itself —
        // the rename twin of the surfaced delete failure below.
        renameChat.mockRejectedValue(new Error("boom"));
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Rename"));
        const input = await screen.findByLabelText("Chat title");
        fireEvent.change(input, { target: { value: "New title" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(
            await screen.findByText(/could not be renamed/i),
        ).toBeInTheDocument();
        // The modal stays open with the typed title so it can be retried.
        expect(screen.getByLabelText("Chat title")).toHaveValue("New title");
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
        );
    });

    it("renames through the rename modal", async () => {
        renameChat.mockResolvedValue(undefined);
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Rename"));
        const input = await screen.findByLabelText("Chat title");
        expect(input).toHaveValue("Quarterly filing");
        fireEvent.change(input, { target: { value: "  New title  " } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(renameChat).toHaveBeenCalledWith("chat-1", "New title");
        await waitFor(() =>
            expect(screen.queryByLabelText("Chat title")).not.toBeInTheDocument(),
        );
    });

    it("keeps the actions trigger revealed while its menu is open", async () => {
        // The trigger is zero-width until the row is hovered; collapsing it
        // under an open menu moves the menu's anchor.
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive={false}
                onSelect={vi.fn()}
            />,
        );
        const trigger = screen.getByRole("button", {
            name: "Actions for Quarterly filing",
        });
        expect(trigger).toHaveClass("pointer-events-none");
        openMenu();
        await screen.findByText("Rename");

        expect(trigger).toHaveClass("w-6", "opacity-100");
        expect(trigger).not.toHaveClass("pointer-events-none");
    });

    it("marks a colleague's chat as shared", async () => {
        // get_chats_overview now lists colleagues' organization-project chats
        // in the same sidebar list as the caller's own, with nothing in the
        // row telling them apart — so a rename or a delete could land on
        // somebody else's thread by mistake.
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "editor" })}
                isActive
                onSelect={vi.fn()}
            />,
        );

        // Plain text, using the same muted treatment as project prefixes.
        const marker = screen.getByText("Shared");
        expect(marker).toHaveClass("text-xs", "text-gray-400", "font-normal");
        // The marker renders in a sibling element, so it reached neither the
        // row's tooltip nor its accessible name: a screen-reader user heard
        // exactly what the thread's owner hears.
        expect(
            screen.getByRole("button", { name: "Quarterly filing (Shared)" }),
        ).toHaveAttribute("title", "Quarterly filing (Shared)");
    });

    it("does not mark the caller's own chat", () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );

        expect(screen.queryByText("Shared")).not.toBeInTheDocument();
    });

    it("claims nothing about a row that carries no is_owner at all", () => {
        // A row with no ownership field has told us nothing; "Shared" would
        // be a claim we cannot make, the same reason roleFrom fails closed.
        render(
            <SidebarChatItem chat={chat({})} isActive onSelect={vi.fn()} />,
        );

        expect(screen.queryByText("Shared")).not.toBeInTheDocument();
    });

    it("surfaces a failed delete instead of swallowing it", async () => {
        deleteChat.mockRejectedValue(new Error("boom"));
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(
            await screen.findByText(/could not be deleted/i),
        ).toBeInTheDocument();
    });

    it("offers opening the chat beside the current one only where asked to", async () => {
        const onOpenInSideChat = vi.fn();
        const { unmount } = render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive={false}
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        expect(screen.queryByText("Open in side chat")).not.toBeInTheDocument();
        unmount();

        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive={false}
                onSelect={vi.fn()}
                onOpenInSideChat={onOpenInSideChat}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Open in side chat"));

        expect(onOpenInSideChat).toHaveBeenCalled();
    });
});

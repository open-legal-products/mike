import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ptBR from "../../../../messages/pt-BR.json";
import { withIntl } from "@/test/withIntl";
import { SidebarChatItem } from "./SidebarChatItem";
import type { Chat } from "@/app/components/shared/types";

// The live round left this surface as the one place still gating on
// `chat.user_id === user.id` with failures swallowed. These tests pin the
// ladder rules the rest of the stack enforces: rename is member-tier
// (content.edit), delete is admin-tier (container.delete), and a failed
// delete is told to the user instead of silently reappearing on reload.

const renameChat = vi.fn();
const deleteChat = vi.fn();

const messages = {
    ...ptBR,
    shell: {
        ...ptBR.shell,
        itemConversa: {
            ...ptBR.shell.itemConversa,
            compartilhar: ptBR.workflows.compartilharModal.compartilhar,
            renomear: ptBR.assistant.renomear,
            excluir: ptBR.assistant.excluir,
            conversaSemTitulo: ptBR.assistant.conversaSemTitulo,
        },
    },
};

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ renameChat, deleteChat }),
}));
vi.mock("@/app/components/assistant/ChatAccessModal", () => ({
    ChatAccessModal: ({ open }: { open: boolean }) =>
        open ? <div>Chat access modal</div> : null,
}));

function chat(overrides: Partial<Chat>): Chat {
    return {
        id: "chat-1",
        title: "Quarterly filing",
        user_id: "someone-else",
        created_at: new Date().toISOString(),
        ...overrides,
    } as Chat;
}

function openMenu() {
    // Radix opens on pointerdown, not click.
    const trigger = screen.getByRole("button", {
        name: "Ações para Quarterly filing",
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
});

describe("SidebarChatItem role gates", () => {
    it("opens chat access from an owner's Share action", async () => {
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({ is_owner: true })}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Compartilhar"));

        expect(await screen.findByText("Chat access modal")).toBeInTheDocument();
    });

    it("gates Share for a non-owner", async () => {
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({ is_owner: false, access_role: "editor" })}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Compartilhar"));

        expect(screen.queryByText("Chat access modal")).not.toBeInTheDocument();
        expect(await screen.findByText(/Somente o proprietário pode/)).toBeInTheDocument();
    });

    it("lets a shared member rename but not delete", async () => {
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({ is_owner: false, access_role: "editor" })}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Excluir"));

        expect(deleteChat).not.toHaveBeenCalled();
        expect(
            await screen.findByText(/Somente o proprietário pode/),
        ).toBeInTheDocument();
    });

    it("lets the creator delete — is_owner alone derives admin", async () => {
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({ is_owner: true })}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Excluir"));

        expect(deleteChat).toHaveBeenCalledWith("chat-1");
    });

    it("refuses a viewer's rename with the member tier", async () => {
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({ is_owner: false, access_role: "viewer" })}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Renomear"));

        expect(
            await screen.findByText(/Somente um editor pode/),
        ).toBeInTheDocument();
    });

    it("lets a project admin delete a colleague's chat", async () => {
        // The exact shape the overview RPC serves an org/project admin for a
        // thread they did not start: is_owner false, access_role "owner".
        // Before the RPC served access_role, this row fell back to "editor"
        // and the admin was refused a delete the server accepts — the
        // headline widening, unreachable from the sidebar.
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({ is_owner: false, access_role: "owner" })}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Excluir"));

        expect(deleteChat).toHaveBeenCalledWith("chat-1");
    });

    it("fails closed to viewer when a row carries no role fields at all", async () => {
        // A row with neither is_owner nor access_role has told us nothing;
        // offering member-tier affordances on it is how the sidebar ended up
        // offering renames the server refuses. Nothing may be offered.
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({})}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Renomear"));

        expect(renameChat).not.toHaveBeenCalled();
        expect(
            await screen.findByText(/Somente um editor pode/),
        ).toBeInTheDocument();
    });

    it("surfaces a failed rename instead of a silent revert", async () => {
        // The context reloads the list on failure, snapping the title back.
        // Without a popup the user just watches their edit undo itself —
        // the rename twin of the surfaced delete failure below.
        renameChat.mockRejectedValue(new Error("boom"));
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({ is_owner: true })}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Renomear"));
        const input = screen.getByRole("textbox");
        fireEvent.change(input, { target: { value: "New title" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(
            await screen.findByText(/não foi possível renomear/i),
        ).toBeInTheDocument();
    });

    it("surfaces a failed delete instead of swallowing it", async () => {
        deleteChat.mockRejectedValue(new Error("boom"));
        render(
            withIntl(
                <SidebarChatItem
                    chat={chat({ is_owner: true })}
                    isActive
                    onSelect={vi.fn()}
                />,
                messages,
            ),
        );
        openMenu();
        fireEvent.click(await screen.findByText("Excluir"));

        expect(
            await screen.findByText(/não foi possível excluir/i),
        ).toBeInTheDocument();
    });
});

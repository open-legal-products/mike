import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectChatSwitcher } from "./ProjectChatSwitcher";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";

function RenameHarness({ onSave }: { onSave: (title: string) => void }) {
    const [title, setTitle] = useState("Current draft");
    const [draft, setDraft] = useState<string | null>(null);
    return (
        <ProjectChatSwitcher
            chats={[
                { id: "chat-1", title },
                { id: "chat-2", title: "Earlier advice" },
            ]}
            currentChatId="chat-1"
            currentTitle={title}
            onLoad={vi.fn()}
            onNewChat={vi.fn()}
            titleEdit={
                draft !== null
                    ? {
                          value: draft,
                          onChange: setDraft,
                          onSave: () => {
                              onSave(draft.trim());
                              setTitle(draft.trim());
                              setDraft(null);
                          },
                          onCancel: () => setDraft(null),
                      }
                    : undefined
            }
            actions={
                <HeaderActionsMenu
                    title="Chat actions"
                    onCloseAutoFocus={(event) => {
                        if (draft !== null) event.preventDefault();
                    }}
                    items={[
                        { label: "Rename", onSelect: () => setDraft(title) },
                    ]}
                />
            }
        />
    );
}

describe("ProjectChatSwitcher", () => {
    it("replaces the title button with a focused input and saves once on Enter", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<RenameHarness onSave={onSave} />);

        await user.click(screen.getByRole("button", { name: "Chat actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));
        const input = screen.getByRole("textbox", { name: "Chat title" });
        await waitFor(() => expect(input).toHaveFocus());
        expect(input).toHaveValue("Current draft");
        expect(input).toHaveClass("h-7");
        expect((input as HTMLInputElement).selectionStart).toBe(0);
        expect((input as HTMLInputElement).selectionEnd).toBe(
            "Current draft".length,
        );
        expect(
            screen.queryByRole("button", { name: "Current draft" }),
        ).toBeNull();

        await user.type(input, "Updated advice", { skipClick: true });
        await user.keyboard("{Enter}");

        expect(onSave).toHaveBeenCalledExactlyOnceWith("Updated advice");
        expect(
            screen.queryByRole("textbox", { name: "Chat title" }),
        ).toBeNull();
        await user.click(
            screen.getByRole("button", { name: "Updated advice" }),
        );
        expect(
            screen.getByRole("menuitem", { name: "Earlier advice" }),
        ).toBeVisible();
    });

    it("discards the draft on Escape without saving on blur", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<RenameHarness onSave={onSave} />);

        await user.click(screen.getByRole("button", { name: "Chat actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));
        const input = screen.getByRole("textbox", { name: "Chat title" });
        await user.clear(input);
        await user.type(input, "Discard this");
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Current draft" }));

        expect(onSave).not.toHaveBeenCalled();
        expect(
            screen.queryByRole("textbox", { name: "Chat title" }),
        ).toBeNull();
    });

    it("saves when the input loses focus", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<RenameHarness onSave={onSave} />);

        await user.click(screen.getByRole("button", { name: "Chat actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));
        const input = screen.getByRole("textbox", { name: "Chat title" });
        await user.clear(input);
        await user.type(input, "  Updated advice  ");
        await user.click(screen.getByRole("button", { name: "New chat" }));

        expect(onSave).toHaveBeenCalledExactlyOnceWith("Updated advice");
        expect(
            screen.getByRole("button", { name: "Updated advice" }),
        ).toBeVisible();
    });

    it("does not submit Enter while text composition is active", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<RenameHarness onSave={onSave} />);

        await user.click(screen.getByRole("button", { name: "Chat actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));
        const input = screen.getByRole("textbox", { name: "Chat title" });
        fireEvent.keyDown(input, { key: "Enter", isComposing: true });

        expect(onSave).not.toHaveBeenCalled();
        expect(input).toBeVisible();
        await user.keyboard("{Enter}");
        expect(onSave).toHaveBeenCalledTimes(1);
    });

    it("keeps the chat header row transparent", () => {
        const { container } = render(
            <ProjectChatSwitcher
                chats={[]}
                currentChatId=""
                currentTitle={null}
                actions={null}
                onLoad={vi.fn()}
                onNewChat={vi.fn()}
            />,
        );

        expect(container.firstElementChild).toHaveClass(
            "bg-transparent",
            "pointer-events-none",
            "pr-3",
        );
        expect(screen.getByRole("button", { name: "New Chat" })).toBeVisible();
        expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
        expect(
            screen.getByRole("button", { name: "New Chat" }).parentElement,
        ).not.toHaveClass("backdrop-blur-xl", "rounded-full");
    });

    it("loads another project chat from the history menu", async () => {
        const user = userEvent.setup();
        const onLoad = vi.fn();
        render(
            <ProjectChatSwitcher
                chats={[
                    { id: "chat-1", title: "Current draft" },
                    { id: "chat-2", title: "Earlier advice" },
                ]}
                currentChatId="chat-1"
                currentTitle="Current draft"
                actions={<button type="button">Actions</button>}
                onLoad={onLoad}
                onNewChat={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("button", { name: "New chat" }).parentElement,
        ).toBe(screen.getByRole("button", { name: "Actions" }).parentElement);

        await user.click(screen.getByRole("button", { name: "Current draft" }));
        await user.click(
            screen.getByRole("menuitem", { name: "Earlier advice" }),
        );

        expect(onLoad).toHaveBeenCalledWith("chat-2");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("filters chat history without showing the active chat", async () => {
        const user = userEvent.setup();
        render(
            <ProjectChatSwitcher
                chats={[
                    { id: "chat-1", title: "Current draft" },
                    { id: "chat-2", title: "Earlier advice" },
                    { id: "chat-3", title: "Witness notes" },
                ]}
                currentChatId="chat-1"
                currentTitle="Current draft"
                actions={null}
                onLoad={vi.fn()}
                onNewChat={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Current draft" }));
        expect(
            screen.queryByRole("menuitem", { name: "Current draft" }),
        ).toBeNull();

        await user.type(screen.getByRole("searchbox"), "witness");
        expect(
            screen.queryByRole("menuitem", { name: "Earlier advice" }),
        ).toBeNull();
        expect(
            screen.getByRole("menuitem", { name: "Witness notes" }),
        ).toBeVisible();
    });
});

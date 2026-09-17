import { useState } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPanelHeader } from "./ChatPanelHeader";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";

function RenameHarness({ onSave }: { onSave: (title: string) => void }) {
    const [title, setTitle] = useState("Current draft");
    const [draft, setDraft] = useState<string | null>(null);
    return (
        <ChatPanelHeader
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

describe("ChatPanelHeader", () => {
    it("closes history when title editing starts and keeps it closed when editing ends", () => {
        const props = {
            chats: [{ id: "chat-2", title: "Earlier advice" }],
            currentChatId: "chat-1",
            currentTitle: "Current draft",
            actions: null,
            onLoad: vi.fn(),
            onNewChat: vi.fn(),
        };
        const { rerender } = render(<ChatPanelHeader {...props} />);
        fireEvent.click(screen.getByRole("button", { name: "Current draft" }));
        expect(screen.getByRole("menu")).toBeVisible();
        rerender(
            <ChatPanelHeader
                {...props}
                titleEdit={{
                    value: "Current draft",
                    onChange: vi.fn(),
                    onSave: vi.fn(),
                    onCancel: vi.fn(),
                }}
            />,
        );
        expect(screen.queryByRole("menu")).toBeNull();
        rerender(<ChatPanelHeader {...props} />);
        expect(screen.getByRole("button", { name: "Current draft" })).toHaveAttribute(
            "aria-expanded", "false",
        );
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("shows compact creation times alongside titles and omits unavailable timestamps", () => {
        const now = Date.parse("2026-09-15T12:00:00Z");
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        const { unmount } = render(
            <ChatPanelHeader
                chats={[
                    {
                        id: "chat-2",
                        title: "Recent advice",
                        created_at: new Date(now - 120_000).toISOString(),
                    },
                    {
                        id: "chat-3",
                        title: "Earlier draft",
                        created_at: new Date(now - 3_600_000).toISOString(),
                    },
                    {
                        id: "chat-4",
                        title: "Yesterday's notes",
                        created_at: new Date(now - 86_400_000).toISOString(),
                    },
                    { id: "chat-5", title: "Legacy chat" },
                    {
                        id: "chat-6",
                        title: "Invalid timestamp",
                        created_at: "invalid",
                    },
                ]}
                currentChatId="chat-1"
                currentTitle="Current draft"
                actions={null}
                onLoad={vi.fn()}
                onNewChat={vi.fn()}
            />,
        );
        try {
            fireEvent.click(
                screen.getByRole("button", { name: "Current draft" }),
            );
            for (const [title, elapsed] of [
                ["Recent advice", "2m"],
                ["Earlier draft", "1h"],
                ["Yesterday's notes", "1d"],
            ]) {
                const row = screen.getByRole("menuitem", {
                    name: new RegExp(title),
                });
                const time = within(row).getByText(elapsed);
                expect(time.tagName).toBe("TIME");
                expect(time).toHaveAttribute("datetime");
                expect(time).toHaveAccessibleName(/^Created /);
                expect(within(row).getByText(title)).toHaveClass("truncate");
            }
            expect(
                screen
                    .getByRole("menuitem", { name: "Legacy chat" })
                    .querySelector("time"),
            ).toBeNull();
            expect(
                screen
                    .getByRole("menuitem", { name: "Invalid timestamp" })
                    .querySelector("time"),
            ).toBeNull();
        } finally {
            unmount();
            clock.mockRestore();
        }
    });

    it("refreshes elapsed times while open and stops the timer when closed", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
        const { unmount } = render(
            <ChatPanelHeader
                chats={[
                    {
                        id: "chat-2",
                        title: "Recent advice",
                        created_at: "2026-09-15T11:58:00Z",
                    },
                ]}
                currentChatId="chat-1"
                currentTitle="Current draft"
                actions={null}
                onLoad={vi.fn()}
                onNewChat={vi.fn()}
            />,
        );
        try {
            fireEvent.click(
                screen.getByRole("button", { name: "Current draft" }),
            );
            expect(screen.getByText("2m")).toBeVisible();
            act(() => vi.advanceTimersByTime(60_000));
            expect(screen.getByText("3m")).toBeVisible();
            fireEvent.click(
                screen.getByRole("button", { name: "Current draft" }),
            );
            expect(vi.getTimerCount()).toBe(0);
            act(() => vi.advanceTimersByTime(3_600_000));
            fireEvent.click(
                screen.getByRole("button", { name: "Current draft" }),
            );
            expect(screen.getByText("1h")).toBeVisible();
        } finally {
            unmount();
            vi.useRealTimers();
        }
    });

    it("replaces the title button with a focused input and saves once on Enter", async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<RenameHarness onSave={onSave} />);

        await user.click(screen.getByRole("button", { name: "Chat actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Rename" }));
        const input = screen.getByRole("textbox", { name: "Chat title" });
        await waitFor(() => expect(input).toHaveFocus());
        expect(input).toHaveValue("Current draft");
        expect(input).toHaveClass("h-6");
        expect(input.parentElement).toHaveClass(
            "liquid-glass-subtle",
            "rounded-full",
        );
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
            <ChatPanelHeader
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
        ).toHaveClass(
            "liquid-glass-subtle",
            "backdrop-blur-xl",
            "rounded-full",
        );
    });

    it("loads another project chat from the history menu", async () => {
        const user = userEvent.setup();
        const onLoad = vi.fn();
        render(
            <ChatPanelHeader
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
            <ChatPanelHeader
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

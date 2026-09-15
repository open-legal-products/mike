import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectChatSwitcher } from "./ProjectChatSwitcher";

describe("ProjectChatSwitcher", () => {
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
        expect(
            screen.getByRole("button", { name: "New Chat" }),
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "New chat" }),
        ).toBeNull();
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

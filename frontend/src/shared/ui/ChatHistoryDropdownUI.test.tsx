import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    ChatHistoryDropdownUI,
    type ChatHistoryDropdownUIProps,
} from "./ChatHistoryDropdownUI";

function renderMenu(props: Partial<ChatHistoryDropdownUIProps> = {}) {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
        <ChatHistoryDropdownUI
            open
            onOpenChange={onOpenChange}
            trigger={<button type="button">History</button>}
            items={[
                { id: "a", title: "Lease review", time: { label: "2m" } },
                { id: "b", title: "NDA triage", current: true },
            ]}
            onSelect={onSelect}
            query=""
            onQueryChange={vi.fn()}
            emptyLabel="No chats yet."
            {...props}
        />,
    );
    return { onSelect, onOpenChange };
}

describe("ChatHistoryDropdownUI", () => {
    it("lists chats as menu items with their time and marks the current one", () => {
        renderMenu();

        expect(
            screen.getByRole("menuitem", { name: /Lease review.*2m/ }),
        ).toBeVisible();
        expect(
            screen.getByRole("menuitem", { name: "NDA triage" }),
        ).toHaveAttribute("aria-current", "page");
        expect(
            screen.getByRole("searchbox", { name: "Search chats" }),
        ).toHaveAttribute("data-dropdown-input", "flush");
    });

    it("closes on select by default and stays open when asked to", () => {
        const first = renderMenu();
        fireEvent.click(screen.getByRole("menuitem", { name: /Lease review/ }));
        expect(first.onSelect).toHaveBeenCalledWith("a");
        expect(first.onOpenChange).toHaveBeenCalledWith(false);
    });

    it("keeps the menu open for a caller that loads the chat first", () => {
        const { onSelect, onOpenChange } = renderMenu({
            closeOnSelect: false,
            items: [{ id: "a", title: "Lease review", pending: true }],
        });
        fireEvent.click(screen.getByRole("menuitem", { name: /Lease review/ }));

        expect(onSelect).toHaveBeenCalledWith("a");
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(
            screen.getByRole("status", { name: "Opening Lease review" }),
        ).toBeVisible();
    });

    it("replaces the rows with a failure and retries it", () => {
        const onRetry = vi.fn();
        renderMenu({ error: "History unavailable", onRetry });

        expect(screen.getByRole("alert")).toHaveTextContent(
            "History unavailable",
        );
        expect(screen.queryByRole("menuitem")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it("shows the loading and empty states", () => {
        const { unmount } = render(
            <ChatHistoryDropdownUI
                open
                onOpenChange={vi.fn()}
                trigger={<button type="button">History</button>}
                items={[]}
                onSelect={vi.fn()}
                query=""
                onQueryChange={vi.fn()}
                emptyLabel="No chats yet."
                loading
            />,
        );
        expect(screen.getByRole("status")).toHaveTextContent("Loading chats…");
        unmount();

        renderMenu({ items: [] });
        expect(screen.getByText("No chats yet.")).toBeVisible();
    });

    it("asks for the next page when the list is scrolled to its end", () => {
        const onReachEnd = vi.fn();
        renderMenu({
            onReachEnd,
            loadingMore: true,
            listProps: { "data-testid": "history-list" },
        });

        fireEvent.scroll(screen.getByTestId("history-list"));
        expect(onReachEnd).toHaveBeenCalledOnce();
        expect(screen.getByText("Loading more chats…")).toBeVisible();
    });
});

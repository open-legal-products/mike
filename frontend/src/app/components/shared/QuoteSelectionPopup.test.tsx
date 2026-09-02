import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { popupPosition, QuoteSelectionPopup } from "./QuoteSelectionPopup";
import type { QuotableSelection } from "@/app/hooks/useQuotableSelection";

const selection = (
    rect: Partial<QuotableSelection["rect"]> = {},
): QuotableSelection => ({
    text: "the indemnity clause",
    rect: { top: 200, bottom: 220, left: 300, right: 460, ...rect },
});

const viewport = { width: 1000, height: 800 };

describe("popupPosition", () => {
    it("sits above the highlight, horizontally centred on it", () => {
        const { top, left } = popupPosition(selection().rect, viewport);
        expect(top).toBe(200 - 32 - 8);
        expect(left).toBe((300 + 460) / 2 - 132 / 2);
    });

    it("flips below the highlight when there is no room above", () => {
        const { top } = popupPosition(
            selection({ top: 4, bottom: 24 }).rect,
            viewport,
        );
        expect(top).toBe(24 + 8);
    });

    it("keeps the popup inside the left edge", () => {
        const { left } = popupPosition(
            selection({ left: 0, right: 10 }).rect,
            viewport,
        );
        expect(left).toBe(8);
    });

    it("keeps the popup inside the right edge", () => {
        const { left } = popupPosition(
            selection({ left: 980, right: 1000 }).rect,
            viewport,
        );
        expect(left).toBe(1000 - 132 - 8);
    });

    it("keeps the popup inside the bottom edge", () => {
        // A highlight scrolled below the fold still gets a visible popup.
        const { top } = popupPosition(
            selection({ top: 900, bottom: 920 }).rect,
            viewport,
        );
        expect(top).toBe(800 - 32 - 8);
    });

    it("clamps to the margin in a viewport too small to fit the popup", () => {
        const { top, left } = popupPosition(selection().rect, {
            width: 20,
            height: 20,
        });
        expect(top).toBe(8);
        expect(left).toBe(8);
    });
});

describe("QuoteSelectionPopup", () => {
    it("renders nothing without a selection", () => {
        render(<QuoteSelectionPopup selection={null} onAdd={() => {}} />);
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("renders a single Add to Chat button", () => {
        render(<QuoteSelectionPopup selection={selection()} onAdd={vi.fn()} />);
        const button = screen.getByRole("button", { name: "Add to Chat" });
        expect(button).toHaveAttribute("type", "button");
        expect(button.className).toContain("focus-visible:ring-2");
    });

    it("passes the excerpt text up when clicked", async () => {
        const onAdd = vi.fn();
        render(<QuoteSelectionPopup selection={selection()} onAdd={onAdd} />);
        await userEvent.click(
            screen.getByRole("button", { name: "Add to Chat" }),
        );
        expect(onAdd).toHaveBeenCalledWith("the indemnity clause");
    });

    it("activates on Enter while the highlight is live", () => {
        const onAdd = vi.fn();
        render(<QuoteSelectionPopup selection={selection()} onAdd={onAdd} />);
        act(() => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter" }),
            );
        });
        expect(onAdd).toHaveBeenCalledWith("the indemnity clause");
    });

    it("leaves Enter alone inside a text field", () => {
        const onAdd = vi.fn();
        render(
            <>
                <textarea data-testid="composer" />
                <QuoteSelectionPopup selection={selection()} onAdd={onAdd} />
            </>,
        );
        act(() => {
            screen
                .getByTestId("composer")
                .dispatchEvent(
                    new KeyboardEvent("keydown", {
                        key: "Enter",
                        bubbles: true,
                    }),
                );
        });
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("ignores Shift+Enter", () => {
        const onAdd = vi.fn();
        render(<QuoteSelectionPopup selection={selection()} onAdd={onAdd} />);
        act(() => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Enter",
                    shiftKey: true,
                }),
            );
        });
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("stops responding to Enter once the selection is gone", () => {
        const onAdd = vi.fn();
        const { rerender } = render(
            <QuoteSelectionPopup selection={selection()} onAdd={onAdd} />,
        );
        rerender(<QuoteSelectionPopup selection={null} onAdd={onAdd} />);
        act(() => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter" }),
            );
        });
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("portals to the body so a scroll container cannot clip it", () => {
        const { container } = render(
            <QuoteSelectionPopup selection={selection()} onAdd={vi.fn()} />,
        );
        expect(container).toBeEmptyDOMElement();
        expect(
            document.body.querySelector(".fixed")?.getAttribute("style"),
        ).toContain("top: 160px");
    });
});

describe("QuoteSelectionPopup — assign action", () => {
    it("offers only Add to Chat when no assign handler is given", () => {
        render(<QuoteSelectionPopup selection={selection()} onAdd={vi.fn()} />);

        expect(
            screen.getByRole("button", { name: "Add to Chat" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Assign to agent" }),
        ).not.toBeInTheDocument();
    });

    it("hands the highlighted text to the assign handler", async () => {
        const user = userEvent.setup();
        const onAssign = vi.fn();
        render(
            <QuoteSelectionPopup
                selection={selection()}
                onAdd={vi.fn()}
                onAssign={onAssign}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Assign to agent" }),
        );
        expect(onAssign).toHaveBeenCalledWith("the indemnity clause");
    });

    it("disables assigning at the agent cap, with the reason as a tooltip", () => {
        render(
            <QuoteSelectionPopup
                selection={selection()}
                onAdd={vi.fn()}
                onAssign={vi.fn()}
                assignDisabledReason="You can run 6 agents on a response."
            />,
        );

        const button = screen.getByRole("button", { name: "Assign to agent" });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute(
            "title",
            "You can run 6 agents on a response.",
        );
    });

    it("keeps Enter bound to Add to Chat, the non-destructive action", async () => {
        const user = userEvent.setup();
        const onAdd = vi.fn();
        const onAssign = vi.fn();
        render(
            <QuoteSelectionPopup
                selection={selection()}
                onAdd={onAdd}
                onAssign={onAssign}
            />,
        );

        await act(async () => {
            await user.keyboard("{Enter}");
        });

        expect(onAdd).toHaveBeenCalledWith("the indemnity clause");
        expect(onAssign).not.toHaveBeenCalled();
    });

    it("widens the safe area so the second action stays on screen", () => {
        const withAssign = popupPosition(
            selection({ left: 980, right: 1000 }).rect,
            viewport,
            { width: 272 },
        );
        expect(withAssign.left).toBe(1000 - 272 - 8);
    });
});

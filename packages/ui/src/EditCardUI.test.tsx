import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EditCardUI } from "./EditCardUI";

describe("EditCardUI", () => {
    it("renders normalized edit content and delegates every action", async () => {
        const user = userEvent.setup();
        const onView = vi.fn();
        const onAccept = vi.fn();
        const onReject = vi.fn();

        render(
            <EditCardUI
                originalText="old text"
                replacementText="new text"
                reason="Use the defined term."
                changeNumber={2}
                status="pending"
                className="test-surface"
                onView={onView}
                onAccept={onAccept}
                onReject={onReject}
            />,
        );

        expect(screen.getByLabelText("Tracked change 2")).toHaveTextContent(
            "2",
        );
        expect(screen.getByLabelText("Tracked change 2")).toHaveClass(
            "self-start",
            "mt-0.5",
        );
        expect(screen.getByLabelText("Tracked change 2")).not.toHaveClass(
            "self-center",
        );
        expect(screen.getByText("new text")).toHaveClass("text-green-700");
        expect(screen.getByText("old text")).toHaveClass(
            "text-red-600",
            "line-through",
        );
        expect(screen.getByText("Use the defined term.")).toHaveClass(
            "font-serif",
            "text-sm",
        );
        expect(
            screen.getAllByRole("button").map((button) => button.textContent),
        ).toEqual(["Accept", "Reject", "View"]);

        await user.click(screen.getByRole("button", { name: "View" }));
        await user.click(screen.getByRole("button", { name: "Accept" }));
        await user.click(screen.getByRole("button", { name: "Reject" }));

        expect(onView).toHaveBeenCalledOnce();
        expect(onAccept).toHaveBeenCalledOnce();
        expect(onReject).toHaveBeenCalledOnce();
    });

    it("supports Word-style status output and disabled actions", async () => {
        const user = userEvent.setup();
        const onView = vi.fn();

        const { container } = render(
            <EditCardUI
                status="view-only"
                statusMessage="Tracked change found — review it in Word."
                statusMessageClassName="text-gray-500"
                ariaBusy
                actionsDisabled
                onView={onView}
            />,
        );

        expect(container.firstChild).toHaveAttribute(
            "data-edit-status",
            "view-only",
        );
        expect(container.firstChild).toHaveAttribute("aria-busy", "true");
        expect(screen.getByRole("status")).toHaveClass("text-gray-500");

        await user.click(screen.getByRole("button", { name: "View" }));
        expect(onView).not.toHaveBeenCalled();
    });

    it("places a proposal's Apply action before View", async () => {
        const user = userEvent.setup();
        const onApply = vi.fn();
        const onView = vi.fn();

        render(
            <EditCardUI
                status="ready"
                onApply={onApply}
                onView={onView}
            />,
        );

        expect(
            screen.getAllByRole("button").map((button) => button.textContent),
        ).toEqual(["Apply", "View"]);
        await user.click(screen.getByRole("button", { name: "Apply" }));
        await user.click(screen.getByRole("button", { name: "View" }));
        expect(onApply).toHaveBeenCalledOnce();
        expect(onView).toHaveBeenCalledOnce();
    });

    it("owns the busy Apply label and disabled state", () => {
        const { container } = render(
            <EditCardUI status="applying-approved" busyAction="apply" />,
        );

        expect(
            screen.getByRole("button", { name: "Applying..." }),
        ).toBeDisabled();
        expect(container.firstChild).toHaveAttribute("aria-busy", "true");
    });
    it("dismisses the card through the close control", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();

        render(<EditCardUI reason="Use the defined term." onClose={onClose} onView={vi.fn()} />);
        const close = screen.getByRole("button", { name: "Close" });
        expect(close.nextElementSibling).toBe(screen.getByRole("button", { name: "View" }));
        expect(close).toHaveClass("bg-transparent", "shadow-none");
        expect(close.querySelector("svg")).toBeNull();

        await user.click(
            screen.getByRole("button", { name: "Close" }),
        );
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("renders the close control even without a number or reason", () => {
        const onClose = vi.fn();

        render(<EditCardUI originalText="old" onClose={onClose} />);

        expect(
            screen.getByRole("button", { name: "Close" }),
        ).toBeInTheDocument();
    });

    it("omits the close control when the card cannot be dismissed", () => {
        render(<EditCardUI reason="Use the defined term." changeNumber={2} />);

        expect(
            screen.queryByRole("button", { name: "Close" }),
        ).not.toBeInTheDocument();
    });
});

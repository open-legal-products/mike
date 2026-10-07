import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WarningPopup } from "./WarningPopup";
import { clearToasts, showToast, ToastViewportUI } from "@/shared/ui/ToastUI";

describe("WarningPopup", () => {
    afterEach(() => clearToasts());

    it("announces warnings and closes on Escape", () => {
        const onClose = vi.fn();
        render(
            <WarningPopup
                open
                title="Save failed"
                message="Please try again."
                onClose={onClose}
            />,
        );

        const alert = screen.getByRole("alert");
        expect(alert).toHaveAttribute("aria-live", "assertive");
        expect(alert).toHaveAttribute("aria-atomic", "true");

        fireEvent.keyDown(document, { key: "Escape" });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("runs its primary action and closes from the dismiss button", () => {
        const onClose = vi.fn();
        const onAdd = vi.fn();
        render(
            <WarningPopup
                open
                title="No API key"
                onClose={onClose}
                primaryAction={{ label: "Add key", onClick: onAdd }}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Add key" }));
        expect(onAdd).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    // The guard for "one source of truth": a popup and an error toast with
    // the same text must render the same card, class for class. If someone
    // restyles one of them locally, this fails and names the difference.
    it("draws exactly the same card as an error toast", () => {
        const title = "Couldn't save";
        const message = "Check your connection.";

        const popup = render(
            <WarningPopup open title={title} message={message} onClose={() => {}} />,
        );
        const popupShape = cardShape(screen.getByRole("alert"));
        popup.unmount();

        render(<ToastViewportUI />);
        act(() => {
            showToast({ tone: "error", title, message });
        });
        const toastShape = cardShape(screen.getByRole("alert"));

        expect(toastShape).toEqual(popupShape);
    });
});

/**
 * Every element's tag and classes, in document order, plus its text when it
 * has no element children. Labels and ARIA wiring are left out because the
 * two wrappers name their close button and live region differently on
 * purpose; what must match is the visual structure.
 */
function cardShape(card: Element): string[] {
    const shape: string[] = [];
    const walk = (node: Element) => {
        const text = node.children.length === 0 ? (node.textContent ?? "") : "";
        shape.push(
            `${node.tagName.toLowerCase()}.${node.getAttribute("class") ?? ""}|${text}`,
        );
        Array.from(node.children).forEach(walk);
    };
    walk(card);
    return shape;
}

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

    // Pins main's popup card class for class. The 2026-10-06 pixel diff
    // showed this markup renders identically to main's original popup; if a
    // NoticeCardUI change alters it, every popup and toast changes, so update
    // this snapshot only on purpose.
    it("keeps main's popup markup", () => {
        render(
            <WarningPopup
                open
                title="Save failed"
                message="Please try again."
                onClose={() => {}}
                primaryAction={{ label: "Retry", onClick: () => {} }}
            />,
        );
        expect(cardShape(screen.getByRole("alert"))).toMatchInlineSnapshot(`
          [
            "div.pointer-events-auto relative flex rounded-2xl px-3 py-3 text-xs liquid-glass-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2|",
            "div.min-w-0 flex-1 text-red-600|",
            "div.mb-1 flex items-center gap-1.5 text-sm font-medium|",
            "svg.lucide lucide-circle-alert lucide-alert-circle h-3 w-3 shrink-0 text-red-600|",
            "circle.|",
            "line.|",
            "line.|",
            "div.text-black pl-[18px]|",
            "span.min-w-0 [overflow-wrap:anywhere]|Please try again.",
            "div.mt-2 flex flex-wrap items-center justify-end gap-1.5|",
            "button.inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 bg-gray-950/88 text-white shadow-[0_3px_9px_rgba(15,23,42,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.10),inset_-4px_-4px_9px_rgba(15,23,42,0.2)] hover:bg-gray-900/90 disabled:hover:bg-gray-950/88 h-7 px-3 text-xs leading-none has-[svg]:pl-2 has-[img]:pl-2|",
            "span.contents|Retry",
            "button.flex shrink-0 items-center justify-center rounded-full text-gray-500 liquid-glass-subtle liquid-glass-hover backdrop-blur-xl transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 absolute right-1.5 top-1.5 h-5 w-5|",
            "svg.lucide lucide-x h-3 w-3|",
            "path.|",
            "path.|",
          ]
        `);
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

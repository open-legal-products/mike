import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { NoticeCardUI, noticeActionClassName } from "./NoticeCardUI";

describe("NoticeCardUI", () => {
    it("draws the glass card with title, indented message and a named close button", () => {
        const onDismiss = vi.fn();
        render(
            <NoticeCardUI
                role="alert"
                title="Couldn't save"
                message="Check your connection."
                onDismiss={onDismiss}
                dismissLabel="Dismiss warning"
            />,
        );

        const card = screen.getByRole("alert");
        expect(card).toHaveClass("liquid-glass-float", "backdrop-blur-2xl");
        expect(card).toHaveAttribute("data-tone", "error");
        // The tone colours the title; the message overrides it to black.
        expect(screen.getByText("Couldn't save").parentElement).toHaveClass(
            "text-red-600",
        );
        // Lines up under the title text, past the 12px icon and 6px gap.
        expect(
            screen.getByText("Check your connection.").parentElement,
        ).toHaveClass("pl-[18px]", "text-black");

        fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
        expect(onDismiss).toHaveBeenCalledOnce();
    });

    it("puts the icon beside the message when there is no title", () => {
        const { container } = render(
            <NoticeCardUI tone="success" message="Saved" onDismiss={() => {}} />,
        );
        const row = screen.getByText("Saved").parentElement;
        expect(row).toHaveClass("flex");
        expect(row?.querySelector("svg")).toHaveClass("text-emerald-700");
        expect(container.firstElementChild).toHaveAttribute(
            "data-tone",
            "success",
        );
    });

    it("renders extra content as given, after the message", () => {
        render(
            <NoticeCardUI title="T" message="M" onDismiss={() => {}}>
                <p>extra</p>
            </NoticeCardUI>,
        );
        // Callers own their content's indent, exactly as WarningPopup did.
        expect(screen.getByText("extra").parentElement).toBe(
            screen.getByText("M").parentElement?.parentElement,
        );
    });

    it("uses a caller's icon in place of the tone icon", () => {
        render(
            <NoticeCardUI
                title="Locked"
                icon={<span data-testid="custom-icon" />}
                onDismiss={() => {}}
            />,
        );
        expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
        expect(screen.getByText("Locked").querySelector("svg")).toBeNull();
    });

    it("renders the action row and forwards the ref and DOM props", () => {
        const ref = createRef<HTMLDivElement>();
        render(
            <NoticeCardUI
                ref={ref}
                role="status"
                tabIndex={-1}
                data-testid="card"
                className="h-auto"
                message="Exported"
                onDismiss={() => {}}
                actions={
                    <button type="button" className={noticeActionClassName()}>
                        Open
                    </button>
                }
            />,
        );
        const card = screen.getByTestId("card");
        expect(ref.current).toBe(card);
        expect(card).toHaveAttribute("role", "status");
        expect(card).toHaveAttribute("tabindex", "-1");
        expect(card).toHaveClass("h-auto");
        expect(screen.getByRole("button", { name: "Open" }).parentElement)
            .toHaveClass("justify-end");
    });
});

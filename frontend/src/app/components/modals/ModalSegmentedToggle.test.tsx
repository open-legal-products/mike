import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ModalSegmentedToggle } from "./ModalSegmentedToggle";

function Toggle({ surface }: { surface?: "subtle" | "flat" }) {
    const [value, setValue] = useState<"a" | "b" | "c">("a");
    return (
        <ModalSegmentedToggle
            value={value}
            onChange={setValue}
            surface={surface}
            options={[
                { value: "a", label: "One" },
                { value: "b", label: "Two" },
                { value: "c", label: "Three" },
            ]}
        />
    );
}

describe("ModalSegmentedToggle", () => {
    it("slides one highlight to the chosen option", async () => {
        const { container } = render(<Toggle />);
        const highlight = container.querySelector<HTMLElement>("[aria-hidden='true']")!;
        expect(highlight).toHaveClass("liquid-glass-selected", "transition-transform");
        expect(highlight.style.transform).toBe("translateX(calc(0 * (100% + 0.25rem)))");

        await userEvent.click(screen.getByRole("button", { name: "Three" }));
        expect(screen.getByRole("button", { name: "Three" })).toHaveAttribute("aria-pressed", "true");
        expect(highlight.style.transform).toBe("translateX(calc(2 * (100% + 0.25rem)))");
        // The options themselves carry no fill, so only the highlight moves.
        expect(screen.getByRole("button", { name: "Three" })).not.toHaveClass("liquid-glass-selected");
    });

    it("uses subtle glass by default and flat glass on a white surface", () => {
        const { container, rerender } = render(<Toggle />);
        expect(container.firstElementChild).toHaveClass("liquid-glass-subtle");
        rerender(<Toggle surface="flat" />);
        expect(container.firstElementChild).toHaveClass("liquid-glass-flat");
        expect(container.firstElementChild).not.toHaveClass("liquid-glass-subtle");
    });
});

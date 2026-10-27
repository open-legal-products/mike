import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextSlabUI } from "./TextSlabUI";

// The text is a direct child, so the matched element is the slab itself.
function slab() {
    return screen.getByText("Slab content");
}

describe("TextSlabUI", () => {
    it("gives every slab the same shape and padding", () => {
        render(<TextSlabUI>Slab content</TextSlabUI>);

        expect(slab()).toHaveClass("rounded-xl", "px-3", "py-2", "bg-gray-100");
    });

    it("swaps the fill when selected, without keeping the resting one", () => {
        // Both fills are single-class selectors, so emitting both would leave
        // the winner up to stylesheet order.
        render(<TextSlabUI selected>Slab content</TextSlabUI>);

        expect(slab()).toHaveClass("citation-quote-selected");
        expect(slab()).not.toHaveClass("bg-gray-100");
    });

    it("lets the caller add typography without losing the base", () => {
        render(
            <TextSlabUI className="font-sans text-xs">Slab content</TextSlabUI>,
        );

        expect(slab()).toHaveClass("font-sans", "text-xs", "rounded-xl", "px-3");
    });

    it("lets the caller override a base class", () => {
        render(<TextSlabUI className="bg-white">Slab content</TextSlabUI>);

        expect(slab()).toHaveClass("bg-white");
        expect(slab()).not.toHaveClass("bg-gray-100");
    });
});

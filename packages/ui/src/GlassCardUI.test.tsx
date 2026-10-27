import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GlassCardUI } from "./GlassCardUI";

describe("GlassCardUI", () => {
    it("renders the shared glass surface around its children", () => {
        render(
            <GlassCardUI>
                <p>Shared content</p>
            </GlassCardUI>,
        );

        expect(screen.getByText("Shared content").parentElement).toHaveClass(
            "rounded-xl",
            "liquid-glass-flat",
        );
    });

    it("does not carry a backdrop blur", () => {
        render(
            <GlassCardUI>
                <p>Shared content</p>
            </GlassCardUI>,
        );

        // The flat material is an opaque fill, so a blur only costs a
        // compositing layer per card.
        expect(
            screen.getByText("Shared content").parentElement?.className,
        ).not.toMatch(/backdrop-blur/);
    });
});

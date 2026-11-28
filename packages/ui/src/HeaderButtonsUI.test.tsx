import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    HeaderButtonUI,
    HeaderButtonsUI,
} from "./HeaderButtonsUI";

describe("HeaderButtonsUI", () => {
    it("renders the shared action group and icon button styling", () => {
        render(
            <HeaderButtonsUI data-testid="actions">
                <HeaderButtonUI iconOnly aria-label="New chat">
                    +
                </HeaderButtonUI>
            </HeaderButtonsUI>,
        );

        expect(screen.getByTestId("actions")).toHaveClass(
            "rounded-full",
            "liquid-glass-subtle",
        );
        expect(screen.getByRole("button", { name: "New chat" })).toHaveClass(
            "h-7",
            "w-7",
            "rounded-full",
            "liquid-glass-hover",
            "liquid-glass-pressed",
        );
    });

    it("shows only the icon of an icon-and-label button on a small screen", () => {
        render(
            <HeaderButtonUI>
                <svg data-testid="icon" />
                Use
            </HeaderButtonUI>,
        );
        const button = screen.getByRole("button", { name: "Use" });
        expect(button).toHaveClass("w-7", "px-0", "md:w-auto", "md:px-3");
        expect(screen.getByText("Use")).toHaveClass("sr-only", "md:not-sr-only");
        expect(screen.getByTestId("icon")).toBeInTheDocument();
    });

    it("keeps the text of a button that has no icon", () => {
        render(<HeaderButtonUI>Compile</HeaderButtonUI>);
        const button = screen.getByRole("button", { name: "Compile" });
        expect(button).toHaveClass("px-3");
        expect(button).not.toHaveClass("w-7");
        expect(button.querySelector(".sr-only")).toBeNull();
    });

    it("drops its own pill on a plain surface, at the same size", () => {
        render(
            <HeaderButtonsUI data-testid="actions" surface="plain">
                <HeaderButtonUI iconOnly aria-label="New chat">
                    +
                </HeaderButtonUI>
            </HeaderButtonsUI>,
        );

        const group = screen.getByTestId("actions");
        expect(group).not.toHaveClass("liquid-glass-subtle");
        expect(group).toHaveClass("px-1", "py-1");
        expect(screen.getByRole("button", { name: "New chat" })).toHaveClass(
            "liquid-glass-hover",
        );
    });
});

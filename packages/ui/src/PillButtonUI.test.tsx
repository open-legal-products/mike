import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PillButtonUI } from "./PillButtonUI";

describe("PillButtonUI", () => {
    it("renders its children as a button by default", () => {
        render(<PillButtonUI tone="black">Save</PillButtonUI>);
        expect(
            screen.getByRole("button", { name: "Save" }),
        ).toBeInTheDocument();
    });

    it("defaults to type=button", () => {
        render(<PillButtonUI tone="black">Save</PillButtonUI>);
        expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
            "type",
            "button",
        );
    });

    it("has a visible keyboard focus ring", () => {
        render(<PillButtonUI tone="black">Save</PillButtonUI>);
        expect(screen.getByRole("button", { name: "Save" })).toHaveClass(
            "focus-visible:ring-2",
        );
    });

    it("applies the tone class", () => {
        render(<PillButtonUI tone="danger">Delete</PillButtonUI>);
        expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
            "bg-red-600/90",
        );
    });

    it("uses the flat liquid surface for the white tone", () => {
        render(<PillButtonUI tone="white">Cancel</PillButtonUI>);

        const button = screen.getByRole("button", { name: "Cancel" });
        expect(button).toHaveClass(
            "liquid-glass-flat",
            "liquid-glass-hover",
        );
        expect(button).not.toHaveClass("bg-white", "shadow-sm");
    });

    it("applies the normal size class when requested", () => {
        render(
            <PillButtonUI tone="blue" size="normal">
                Continue
            </PillButtonUI>,
        );
        expect(screen.getByRole("button", { name: "Continue" })).toHaveClass(
            "text-sm",
        );
    });

    it("defaults to the sm size class", () => {
        render(<PillButtonUI tone="blue">Next</PillButtonUI>);
        expect(screen.getByRole("button", { name: "Next" })).toHaveClass(
            "text-xs",
        );
    });

    it.each([
        ["xs" as const, "px-2.5", "has-[svg]:pl-1.5"],
        ["sm" as const, "px-3", "has-[svg]:pl-2"],
        ["normal" as const, "px-4", "has-[svg]:pl-3"],
    ])(
        "reduces left padding by one when the %s size includes an icon",
        (size, horizontalPadding, iconLeftPadding) => {
            render(
                <PillButtonUI tone="blue" size={size}>
                    <svg aria-hidden="true" />
                    Continue
                </PillButtonUI>,
            );

            expect(
                screen.getByRole("button", { name: "Continue" }),
            ).toHaveClass(horizontalPadding, iconLeftPadding);
        },
    );

    it("uses the icon-xs size for compact icon-only buttons", () => {
        render(
            <PillButtonUI tone="white" size="icon-xs" aria-label="Download">
                <svg aria-hidden="true" />
            </PillButtonUI>,
        );

        expect(screen.getByRole("button", { name: "Download" })).toHaveClass(
            "h-6",
            "w-6",
            "p-0",
        );
    });

    it("keeps symmetric padding when no icon is included", () => {
        render(
            <PillButtonUI tone="blue" size="normal">
                Continue
            </PillButtonUI>,
        );

        const button = screen.getByRole("button", { name: "Continue" });
        expect(button).toHaveClass("px-4");
        expect(button).not.toHaveClass("pl-3");
    });

    it("fires onClick when activated", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(
            <PillButtonUI tone="white" onClick={onClick}>
                Click me
            </PillButtonUI>,
        );

        await user.click(screen.getByRole("button", { name: "Click me" }));

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("does not fire onClick while disabled", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(
            <PillButtonUI tone="black" disabled onClick={onClick}>
                Disabled
            </PillButtonUI>,
        );

        await user.click(screen.getByRole("button", { name: "Disabled" }));

        expect(onClick).not.toHaveBeenCalled();
    });

    it("replaces its icon with a spinner and disables itself while loading", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        const { container } = render(
            <PillButtonUI tone="black" loading onClick={onClick}>
                <svg data-testid="save-icon" aria-hidden="true" />
                Saving...
            </PillButtonUI>,
        );

        const button = screen.getByRole("button", { name: "Saving..." });
        const iconContainer = screen.getByTestId("save-icon").parentElement;

        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-busy", "true");
        expect(button).toHaveAttribute("data-loading", "true");
        expect(
            container.querySelector('[data-slot="pill-button-spinner"]'),
        ).toBeInTheDocument();
        expect(iconContainer).toHaveClass("[&_svg]:hidden");

        await user.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

});

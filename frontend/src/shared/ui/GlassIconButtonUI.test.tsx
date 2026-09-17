import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GlassIconButtonUI } from "./GlassIconButtonUI";

describe("GlassIconButtonUI", () => {
    it("exposes the required accessible name", () => {
        render(
            <GlassIconButtonUI aria-label="Close">
                <svg />
            </GlassIconButtonUI>,
        );
        expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    });

    it("defaults to type=button so it never submits a form", () => {
        render(
            <GlassIconButtonUI aria-label="Close">
                <svg />
            </GlassIconButtonUI>,
        );
        expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute(
            "type",
            "button",
        );
    });

    it("carries the shared glass surface classes", () => {
        render(
            <GlassIconButtonUI aria-label="Close">
                <svg />
            </GlassIconButtonUI>,
        );
        expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
            "h-7",
            "w-7",
            "rounded-full",
            "liquid-glass-subtle",
            "liquid-glass-hover",
            "backdrop-blur-xl",
        );
    });

    it("has a visible keyboard focus ring", () => {
        render(
            <GlassIconButtonUI aria-label="Close">
                <svg />
            </GlassIconButtonUI>,
        );
        expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
            "focus-visible:ring-2",
        );
    });

    it("lets callers override classes without losing the base", () => {
        render(
            <GlassIconButtonUI aria-label="Close" className="ml-auto">
                <svg />
            </GlassIconButtonUI>,
        );
        const button = screen.getByRole("button", { name: "Close" });
        expect(button).toHaveClass("ml-auto", "rounded-full");
    });

    it("fires onClick when activated", async () => {
        const onClick = vi.fn();
        const user = userEvent.setup();
        render(
            <GlassIconButtonUI aria-label="Close" onClick={onClick}>
                <svg />
            </GlassIconButtonUI>,
        );

        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(onClick).toHaveBeenCalledTimes(1);
    });
});

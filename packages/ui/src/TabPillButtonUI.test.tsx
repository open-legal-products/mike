import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TabPillButtonUI, TabPillSurfaceContext } from "./TabPillButtonUI";

describe("TabPillButtonUI", () => {
    it("defaults to type=button", () => {
        render(<TabPillButtonUI>All</TabPillButtonUI>);
        expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
            "type",
            "button",
        );
    });

    it("reports its selected state to assistive tech", () => {
        render(<TabPillButtonUI active>Mine</TabPillButtonUI>);
        const button = screen.getByRole("button", { name: "Mine" });
        expect(button).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        expect(button).toHaveClass(
            "border-white/80",
            "bg-white",
            "text-gray-900",
        );
        expect(button).not.toHaveClass("liquid-glass-selected");
    });

    it("uses the flat material inside a flat panel, marking the active tab by its text", () => {
        render(
            <>
                <TabPillButtonUI surface="flat" active>
                    Overview
                </TabPillButtonUI>
                <TabPillButtonUI surface="flat" active={false}>
                    Positions
                </TabPillButtonUI>
            </>,
        );
        const active = screen.getByRole("button", { name: "Overview" });
        expect(active).toHaveClass("liquid-glass-flat", "text-gray-900");
        expect(active).not.toHaveClass(
            "liquid-glass-subtle",
            "liquid-glass-selected",
            "bg-white",
        );
        expect(screen.getByRole("button", { name: "Positions" })).toHaveClass(
            "liquid-glass-flat",
            "liquid-glass-hover",
        );
    });

    it("omits aria-pressed when the button is not a toggle", () => {
        render(<TabPillButtonUI>Neutral</TabPillButtonUI>);
        const button = screen.getByRole("button", { name: "Neutral" });
        expect(button).not.toHaveAttribute("aria-pressed");
        expect(button).toHaveClass("liquid-glass-hover");
    });

    it("has a visible keyboard focus ring", () => {
        render(<TabPillButtonUI active>Mine</TabPillButtonUI>);
        expect(screen.getByRole("button", { name: "Mine" })).toHaveClass(
            "liquid-glass-subtle",
            "focus-visible:ring-2",
        );
    });

    it("takes its surface from the context unless it names its own", () => {
        render(
            <TabPillSurfaceContext.Provider value="plain">
                <TabPillButtonUI>All</TabPillButtonUI>
                <TabPillButtonUI surface="subtle">Subtle</TabPillButtonUI>
            </TabPillSurfaceContext.Provider>,
        );
        const all = screen.getByRole("button", { name: "All" });
        expect(all).toHaveAttribute("data-surface", "plain");
        expect(all).not.toHaveClass("liquid-glass-subtle");
        expect(screen.getByRole("button", { name: "Subtle" })).toHaveClass(
            "liquid-glass-subtle",
        );
    });

    it("is text only on a plain surface, grey on hover and when active", () => {
        render(
            <>
                <TabPillButtonUI surface="plain" active>
                    Mine
                </TabPillButtonUI>
                <TabPillButtonUI surface="plain">All</TabPillButtonUI>
            </>,
        );
        const active = screen.getByRole("button", { name: "Mine" });
        const inactive = screen.getByRole("button", { name: "All" });
        for (const pill of [active, inactive]) {
            expect(pill).not.toHaveClass("liquid-glass-subtle");
            expect(pill).not.toHaveClass("liquid-glass-flat");
        }
        expect(active).toHaveClass("liquid-glass-selected", "text-gray-900");
        expect(active).not.toHaveClass("bg-white");
        expect(inactive).toHaveClass("liquid-glass-hover", "text-gray-500");
    });
});

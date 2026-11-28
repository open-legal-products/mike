import { render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabPillButtonUI } from "@mike/ui";
import { TableToolbar } from "./TableToolbar";

describe("TableToolbar", () => {
    beforeEach(() => {
        vi.stubGlobal(
            "matchMedia",
            vi.fn().mockReturnValue({
                matches: true,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            }),
        );
    });

    it("reduces left padding for icon actions on the right", () => {
        render(
            <TableToolbar
                items={[{ id: "all", label: "All" }]}
                active="all"
                actions={
                    <TabPillButtonUI>
                        <Plus aria-hidden="true" />
                        Folder
                    </TabPillButtonUI>
                }
            />,
        );

        const action = screen.getByRole("button", { name: "Folder" });
        expect(action).toHaveAttribute("data-slot", "tab-pill-button");
        expect(action.parentElement).toHaveClass(
            "[&_[data-slot=tab-pill-button]:not([data-icon-position=right]):has(svg)]:pl-2",
        );
    });

    it("does not horizontally clip the tab area", () => {
        render(
            <TableToolbar items={[{ id: "all", label: "All" }]} active="all" />,
        );

        expect(
            screen.getByRole("button", { name: "All" }).parentElement,
        ).not.toHaveClass("overflow-x-auto");
    });

    it("gives its pills, and those its actions render, no glass", () => {
        render(
            <TableToolbar
                items={[
                    { id: "all", label: "All" },
                    { id: "mine", label: "Mine" },
                ]}
                active="all"
                actions={<TabPillButtonUI>Actions</TabPillButtonUI>}
            />,
        );
        for (const name of ["All", "Mine", "Actions"]) {
            const pill = screen.getByRole("button", { name });
            expect(pill).toHaveAttribute("data-surface", "plain");
            expect(pill).not.toHaveClass("liquid-glass-subtle");
            expect(pill).not.toHaveClass("liquid-glass-flat");
        }
        expect(screen.getByRole("button", { name: "All" })).toHaveClass(
            "liquid-glass-selected",
        );
        expect(screen.getByRole("button", { name: "Mine" })).toHaveClass(
            "liquid-glass-hover",
        );
        // The active tab is told by its state, not by colour alone.
        expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
    });

    it("sets its first pill's left end in line with the page title", () => {
        const { container } = render(
            <TableToolbar items={[{ id: "all", label: "All" }]} active="all" />,
        );
        // The title's own margins: 16px, and 24px from md up.
        expect(container.firstElementChild).toHaveClass("mx-4", "md:mx-6");
    });
});

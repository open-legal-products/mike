import { render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
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
            "[&_[data-slot=tab-pill-button]:has(svg)]:pl-2",
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
});

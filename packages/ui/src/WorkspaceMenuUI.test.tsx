import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dropdown, DropdownContent, DropdownTrigger } from "./dropdown";
import { WorkspaceMenuUI, type WorkspaceMenuUIProps } from "./WorkspaceMenuUI";

const ORGS = [
    { id: "org-acme", name: "Acme LLP" },
    { id: "org-beta", name: "Beta Chambers" },
];

function renderMenu(props: Partial<WorkspaceMenuUIProps> = {}) {
    const onSelect = vi.fn();
    render(
        <Dropdown open>
            <DropdownTrigger>Account</DropdownTrigger>
            <DropdownContent>
                <WorkspaceMenuUI
                    workspaceId="org-acme"
                    organizations={ORGS}
                    onSelect={onSelect}
                    {...props}
                />
            </DropdownContent>
        </Dropdown>,
    );
    return { onSelect };
}

describe("WorkspaceMenuUI", () => {
    it("offers Personal and each organization, the active one checked", () => {
        renderMenu();

        expect(screen.getByRole("group", { name: "Workspace" })).toBeVisible();
        const items = screen.getAllByRole("menuitemradio");
        expect(items.map((item) => item.textContent)).toEqual([
            "Personal",
            "Acme LLP",
            "Beta Chambers",
        ]);
        expect(
            screen.getByRole("menuitemradio", { name: "Acme LLP" }),
        ).toHaveAttribute("aria-checked", "true");
        expect(
            screen.getByRole("menuitemradio", { name: "Personal" }),
        ).toHaveAttribute("aria-checked", "false");
        expect(screen.queryByRole("separator")).toBeNull();
    });

    it("reports the chosen workspace", () => {
        const { onSelect } = renderMenu();
        fireEvent.click(screen.getByRole("menuitemradio", { name: "Personal" }));
        expect(onSelect).toHaveBeenCalledWith("personal");
    });

    it("draws the caller's mark before each name, hidden from the item's name", () => {
        renderMenu({
            renderIcon: (option) => (
                <span data-testid={`icon-${option.id}`}>{option.name[0]}</span>
            ),
        });

        const acme = screen.getByRole("menuitemradio", { name: "Acme LLP" });
        const icon = screen.getByTestId("icon-org-acme");
        expect(acme).toContainElement(icon);
        expect(icon.parentElement).toHaveAttribute("aria-hidden", "true");
        expect(screen.getByTestId("icon-personal")).toBeInTheDocument();
    });

    it("can end with a separator for items below it", () => {
        renderMenu({ trailingSeparator: true });
        expect(screen.getByRole("separator")).toBeInTheDocument();
    });

    it("renders nothing with no organizations or no workspace", () => {
        renderMenu({ organizations: [] });
        expect(screen.queryByRole("menuitemradio")).toBeNull();
    });

    it("renders nothing outside a workspace", () => {
        renderMenu({ workspaceId: null });
        expect(screen.queryByText("Workspace")).toBeNull();
    });
});

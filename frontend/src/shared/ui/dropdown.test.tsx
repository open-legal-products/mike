import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    Dropdown,
    DropdownAtPoint,
    DropdownCheckboxItem,
    DropdownContent,
    DropdownItem,
    DropdownRadioGroup,
    DropdownRadioItem,
    DropdownSurface,
    DropdownTrigger,
} from "./dropdown";

describe("dropdown", () => {
    it("uses the floating liquid-glass material for its open menu", () => {
        render(
            <Dropdown open>
                <DropdownTrigger>Options</DropdownTrigger>
                <DropdownContent data-testid="dropdown-content">
                    <DropdownItem>First option</DropdownItem>
                </DropdownContent>
            </Dropdown>,
        );

        expect(screen.getByTestId("dropdown-content")).toHaveClass(
            "liquid-glass-float",
            "theme-dropdown-surface",
        );
    });

    it("stacks at z-250 by default and lets a caller override it", () => {
        render(
            <>
                <Dropdown open>
                    <DropdownTrigger>Default</DropdownTrigger>
                    <DropdownContent data-testid="default">
                        <DropdownItem>One</DropdownItem>
                    </DropdownContent>
                </Dropdown>
                <Dropdown open>
                    <DropdownTrigger>Override</DropdownTrigger>
                    <DropdownContent data-testid="override" className="z-40">
                        <DropdownItem>Two</DropdownItem>
                    </DropdownContent>
                </Dropdown>
                <DropdownSurface data-testid="surface" />
            </>,
        );

        expect(screen.getByTestId("default")).toHaveClass("z-[250]");
        expect(screen.getByTestId("surface")).toHaveClass("z-[250]");
        expect(screen.getByTestId("override")).toHaveClass("z-40");
        expect(screen.getByTestId("override")).not.toHaveClass("z-[250]");
    });

    it("marks selected and destructive items and gives items a focus ring", () => {
        render(
            <Dropdown open>
                <DropdownTrigger>Options</DropdownTrigger>
                <DropdownContent>
                    <DropdownItem selected>Current</DropdownItem>
                    <DropdownItem variant="destructive">Delete</DropdownItem>
                    <DropdownCheckboxItem checked>Shown</DropdownCheckboxItem>
                </DropdownContent>
            </Dropdown>,
        );

        const current = screen.getByRole("menuitem", { name: "Current" });
        expect(current).toHaveAttribute("data-selected", "true");
        expect(current).toHaveClass(
            "theme-dropdown-item",
            "focus-visible:ring-2",
        );
        expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass(
            "text-red-600",
        );
        expect(
            screen.getByRole("menuitemcheckbox", { name: "Shown" }),
        ).toHaveAttribute("aria-checked", "true");
    });

    it("spaces rows 4px apart and keeps every focus ring inset", () => {
        render(
            <Dropdown open>
                <DropdownTrigger>Options</DropdownTrigger>
                <DropdownContent data-testid="content">
                    <DropdownItem>One</DropdownItem>
                    <DropdownRadioGroup data-testid="group" value="a">
                        <DropdownRadioItem value="a">A</DropdownRadioItem>
                    </DropdownRadioGroup>
                </DropdownContent>
            </Dropdown>,
        );

        const content = screen.getByTestId("content");
        expect(content).toHaveClass("flex", "flex-col", "gap-1");
        expect(screen.getByTestId("group")).toHaveClass("flex-col", "gap-1");
        // Enforced on the surface, so controls with their own offset ring
        // are inset too.
        expect(content.className).toContain("focus-visible:ring-inset");
        expect(content.className).toContain("focus-visible:ring-offset-0");
        for (const role of ["menuitem", "menuitemradio"]) {
            expect(screen.getByRole(role)).toHaveClass(
                "focus-visible:ring-inset",
            );
        }
    });

    it("opens a menu at a point and reports when it is dismissed", () => {
        const onClose = vi.fn();
        const onSelect = vi.fn();
        render(
            <DropdownAtPoint point={{ x: 120, y: 80 }} onClose={onClose}>
                <DropdownItem onSelect={onSelect}>Rename</DropdownItem>
            </DropdownAtPoint>,
        );

        fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

        expect(onSelect).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("closes a menu at a point on Escape", () => {
        const onClose = vi.fn();
        render(
            <DropdownAtPoint point={{ x: 0, y: 0 }} onClose={onClose}>
                <DropdownItem>Rename</DropdownItem>
            </DropdownAtPoint>,
        );

        fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

        expect(onClose).toHaveBeenCalledOnce();
    });

    it("leaves a press on its own trigger to the trigger, and dismisses on any other", async () => {
        const onOpenChange = vi.fn();
        render(
            <>
                <Dropdown open modal={false} onOpenChange={onOpenChange}>
                    <DropdownTrigger>Options</DropdownTrigger>
                    <DropdownContent>
                        <DropdownItem>First option</DropdownItem>
                    </DropdownContent>
                </Dropdown>
                <button type="button">Elsewhere</button>
            </>,
        );
        // The menu starts listening for outside presses a tick after it opens.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const press = (name: string) =>
            fireEvent.pointerDown(
                screen.getByText(name),
                new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
            );

        // The trigger answers its own press by toggling: one call, not also
        // a dismissal. Two would shut a menu the same press had just
        // reopened while it was still animating closed.
        press("Options");
        expect(onOpenChange).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenLastCalledWith(false);

        onOpenChange.mockClear();
        press("Elsewhere");
        expect(onOpenChange).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
});

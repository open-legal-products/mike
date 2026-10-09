import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    Dropdown,
    DropdownContent,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { RowActionMenuItems, RowActions } from "./RowActions";

describe("RowActions", () => {
    it("still closes ordinary add actions without progress feedback", async () => {
        const user = userEvent.setup();
        const onAdd = vi.fn();
        render(<RowActions onAdd={onAdd} addLabel="Import" />);
        await user.click(screen.getByRole("button", { name: "Open row actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Import" }));
        expect(onAdd).toHaveBeenCalledOnce();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("offers and runs the view action from the row button menu", async () => {
        const user = userEvent.setup();
        const onView = vi.fn();
        render(<RowActions onView={onView} onDelete={vi.fn()} />);

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "View" }));

        expect(onView).toHaveBeenCalledOnce();
        expect(
            screen.queryByRole("menuitem", { name: "View" }),
        ).not.toBeInTheDocument();
    });

    it("supports a concise edit label", async () => {
        const user = userEvent.setup();
        render(<RowActions onEditDetails={vi.fn()} editDetailsLabel="Edit" />);

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );

        expect(screen.getByRole("menuitem", { name: "Edit" })).toBeVisible();
        expect(
            screen.queryByRole("menuitem", { name: "Edit details" }),
        ).not.toBeInTheDocument();
    });

    it("offers and runs a deselect-rows action", async () => {
        const user = userEvent.setup();
        const onDeselect = vi.fn();
        render(<RowActions onDeselect={onDeselect} />);

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Deselect rows" }));

        expect(onDeselect).toHaveBeenCalledOnce();
        expect(
            screen.queryByRole("menuitem", { name: "Deselect rows" }),
        ).not.toBeInTheDocument();
    });
});

// The folder context menu offered "New subfolder" to every reader, and the
// handler behind it opened the name field with no gate of its own — so a
// viewer typed a folder name before the server's refusal arrived. It is shown
// disabled instead, the way Delete already was.
describe("RowActionMenuItems New subfolder", () => {
    // The items are dropdown items, so they render inside an open menu.
    function renderItems(props: Parameters<typeof RowActionMenuItems>[0]) {
        render(
            <Dropdown open>
                <DropdownTrigger>Menu</DropdownTrigger>
                <DropdownContent>
                    <RowActionMenuItems {...props} />
                </DropdownContent>
            </Dropdown>,
        );
    }

    it("is disabled and inert when the caller cannot organize folders", () => {
        const onNewSubfolder = vi.fn();
        renderItems({
            onClose: vi.fn(),
            onNewSubfolder,
            newSubfolderDisabled: true,
        });

        const item = screen.getByRole("menuitem", { name: "New subfolder" });
        expect(item).toHaveAttribute("aria-disabled", "true");

        fireEvent.click(item);
        expect(onNewSubfolder).not.toHaveBeenCalled();
    });

    it("stays live for an editor", () => {
        const onNewSubfolder = vi.fn();
        const onClose = vi.fn();
        renderItems({ onClose, onNewSubfolder });

        const item = screen.getByRole("menuitem", { name: "New subfolder" });
        expect(item).not.toHaveAttribute("aria-disabled");

        fireEvent.click(item);
        expect(onNewSubfolder).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

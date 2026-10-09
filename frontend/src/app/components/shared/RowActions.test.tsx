import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    Dropdown,
    DropdownContent,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { RowActionMenuItems, RowActions } from "./RowActions";

describe("RowActions", () => {
    beforeEach(() => clearToasts());
    afterEach(() => clearToasts());

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

describe("RowActions delete failures", () => {
    beforeEach(() => clearToasts());
    afterEach(() => clearToasts());

    it("reports a rejected delete even though the menu has closed", async () => {
        const user = userEvent.setup();
        const onDelete = vi.fn().mockRejectedValue(new Error("boom"));
        render(
            <>
                <RowActions onDelete={onDelete} />
                <ToastViewportUI />
            </>,
        );

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: /^Delete/ }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't delete this item");
        expect(alert).not.toHaveTextContent("boom");
    });

    it("retries only the delete that failed", async () => {
        const user = userEvent.setup();
        const onDelete = vi
            .fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce(undefined);
        render(
            <>
                <RowActions onDelete={onDelete} />
                <ToastViewportUI />
            </>,
        );

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: /^Delete/ }));
        await user.click(await screen.findByRole("button", { name: "Retry" }));

        expect(onDelete).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("names the row action when the caller renamed the delete label", async () => {
        const user = userEvent.setup();
        render(
            <>
                <RowActions
                    onDelete={vi.fn().mockRejectedValue(new Error("boom"))}
                    deleteLabel="Delete review"
                />
                <ToastViewportUI />
            </>,
        );

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Delete review" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Couldn't delete review",
        );
    });
});

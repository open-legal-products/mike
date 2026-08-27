import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RowActions } from "./RowActions";

describe("RowActions", () => {
    it("offers and runs the view action from the row button menu", async () => {
        const user = userEvent.setup();
        const onView = vi.fn();
        render(<RowActions onView={onView} onDelete={vi.fn()} />);

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );
        await user.click(screen.getByRole("button", { name: "View" }));

        expect(onView).toHaveBeenCalledOnce();
        expect(
            screen.queryByRole("button", { name: "View" }),
        ).not.toBeInTheDocument();
    });

    it("supports a concise edit label", async () => {
        const user = userEvent.setup();
        render(
            <RowActions
                onEditDetails={vi.fn()}
                editDetailsLabel="Edit"
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Open row actions" }),
        );

        expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Edit details" }),
        ).not.toBeInTheDocument();
    });
});

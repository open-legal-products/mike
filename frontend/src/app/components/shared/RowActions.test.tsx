import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { RowActions } from "./RowActions";

describe("RowActions", () => {
    it("offers and runs the view action from the row button menu", async () => {
        const user = userEvent.setup();
        const onView = vi.fn();
        render(withIntl(<RowActions onView={onView} onDelete={vi.fn()} />));

        await user.click(
            screen.getByRole("button", { name: "Abrir ações da linha" }),
        );
        await user.click(screen.getByRole("button", { name: "Visualizar" }));

        expect(onView).toHaveBeenCalledOnce();
        expect(
            screen.queryByRole("button", { name: "Visualizar" }),
        ).not.toBeInTheDocument();
    });

    it("supports a concise edit label", async () => {
        const user = userEvent.setup();
        render(
            withIntl(
                <RowActions
                    onEditDetails={vi.fn()}
                    editDetailsLabel="Edit"
                />,
            ),
        );

        await user.click(
            screen.getByRole("button", { name: "Abrir ações da linha" }),
        );

        expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
        expect(
            screen.queryByRole("button", { name: "Editar detalhes" }),
        ).not.toBeInTheDocument();
    });

    it("offers and runs a deselect-rows action", async () => {
        const user = userEvent.setup();
        const onDeselect = vi.fn();
        render(withIntl(<RowActions onDeselect={onDeselect} />));

        await user.click(
            screen.getByRole("button", { name: "Abrir ações da linha" }),
        );
        await user.click(
            screen.getByRole("button", { name: "Desmarcar linhas" }),
        );

        expect(onDeselect).toHaveBeenCalledOnce();
        expect(
            screen.queryByRole("button", { name: "Desmarcar linhas" }),
        ).not.toBeInTheDocument();
    });
});

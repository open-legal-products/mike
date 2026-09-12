import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { DocumentUploadMenu } from "./DocumentUploadMenu";

describe("DocumentUploadMenu", () => {
    it("offers saved, file, and folder sources", async () => {
        const user = userEvent.setup();
        const onSavedFiles = vi.fn();
        const onUploadFiles = vi.fn();
        const onUploadFolder = vi.fn();
        render(
            withIntl(<DocumentUploadMenu
                onSavedFiles={onSavedFiles}
                onUploadFiles={onUploadFiles}
                onUploadFolder={onUploadFolder}
            />),
        );

        await user.click(screen.getByRole("button", { name: "Enviar" }));
        expect(screen.getAllByRole("menuitem")).toHaveLength(3);
        await user.click(screen.getByRole("menuitem", { name: "Arquivos salvos" }));
        expect(onSavedFiles).toHaveBeenCalledOnce();

        await user.click(screen.getByRole("button", { name: "Enviar" }));
        await user.click(screen.getByRole("menuitem", { name: "Enviar arquivos" }));
        expect(onUploadFiles).toHaveBeenCalledOnce();

        await user.click(screen.getByRole("button", { name: "Enviar" }));
        await user.click(
            screen.getByRole("menuitem", { name: "Enviar pasta" }),
        );
        expect(onUploadFolder).toHaveBeenCalledOnce();
    });

    it("omits saved files when the caller does not support them", async () => {
        const user = userEvent.setup();
        render(
            withIntl(<DocumentUploadMenu
                onUploadFiles={vi.fn()}
                onUploadFolder={vi.fn()}
            />),
        );

        await user.click(screen.getByRole("button", { name: "Enviar" }));
        expect(screen.queryByRole("menuitem", { name: "Arquivos salvos" })).toBeNull();
        expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    });

    it("omits folder upload when the caller does not support it", async () => {
        const user = userEvent.setup();
        render(
            withIntl(<DocumentUploadMenu
                onSavedFiles={vi.fn()}
                onUploadFiles={vi.fn()}
            />),
        );

        await user.click(screen.getByRole("button", { name: "Enviar" }));
        expect(
            screen.queryByRole("menuitem", { name: "Enviar pasta" }),
        ).toBeNull();
        expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    });

    it("disables upload while its collection is loading", () => {
        render(
            withIntl(<DocumentUploadMenu
                onUploadFiles={vi.fn()}
                onUploadFolder={vi.fn()}
                disabled
            />),
        );

        expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    });
});

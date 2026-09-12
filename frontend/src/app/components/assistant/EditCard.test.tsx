import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { EditCard } from "./EditCard";

const { resolveDocumentEdit } = vi.hoisted(() => ({
    resolveDocumentEdit: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({ resolveDocumentEdit }));

const annotation = {
    edit_id: "edit-1",
    document_id: "document-1",
    version_id: "version-1",
    change_id: "change-1",
    deleted_text: "old text",
    inserted_text: "new text",
    reason: "Keep the language precise.",
    status: "pending" as const,
};

describe("EditCard", () => {
    beforeEach(() => {
        resolveDocumentEdit.mockReset();
    });

    it("runs the shared View action without making the change text clickable", () => {
        const onViewClick = vi.fn();
        render(
            withIntl(
                <EditCard
                    changeNumber={3}
                    annotation={annotation}
                    onViewClick={onViewClick}
                />,
            ),
        );

        expect(screen.getByLabelText("Tracked change 3")).toHaveTextContent(
            "3",
        );
        expect(screen.getByText(annotation.reason)).toHaveClass(
            "font-serif",
            "text-sm",
        );
        expect(
            screen.getByText(annotation.inserted_text).parentElement,
        ).toHaveClass("font-sans", "text-xs");
        expect(screen.getByText(annotation.inserted_text).parentElement).not.toHaveAttribute(
            "role",
            "button",
        );
        fireEvent.click(screen.getByRole("button", { name: "Ver" }));
        expect(onViewClick).toHaveBeenCalledWith(annotation);
    });

    it.each([
        ["accept", "Aceitar", "Aceitando...", "Aceito"],
        ["reject", "Rejeitar", "Rejeitando...", "Rejeitado"],
    ] as const)(
        "shows the %s action while the request is pending",
        async (verb, idleLabel, busyLabel, resolvedLabel) => {
            let finish!: (value: unknown) => void;
            resolveDocumentEdit.mockReturnValueOnce(
                new Promise((resolve) => {
                    finish = resolve;
                }),
            );

            render(withIntl(<EditCard annotation={annotation} />));
            fireEvent.click(
                screen.getByRole("button", { name: idleLabel }),
            );

            expect(
                screen.getByRole("button", { name: busyLabel }),
            ).toBeDisabled();
            expect(
                screen.getByRole("button", {
                    name: verb === "accept" ? "Rejeitar" : "Aceitar",
                }),
            ).toBeDisabled();

            finish({
                status: verb === "accept" ? "accepted" : "rejected",
                version_id: "version-2",
                download_url: null,
            });

            await waitFor(() =>
                expect(
                    screen.getByRole("button", { name: resolvedLabel }),
                ).toBeDisabled(),
            );
        },
    );
});

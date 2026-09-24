import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditCard, applyOptimisticResolution } from "./EditCard";

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
    it("resolves every EigenPal revision run and reverts on failure", () => {
        const { container } = render(
            <div data-document-id="document-1"><div className="docx-view-container">
                {["first", "second"].map((text) => <span key={text}
                    data-revision-kind="insert" data-revision-id="8">{text}</span>)}
                <span data-revision-kind="delete" data-revision-id="7">old text</span>
            </div></div>,
        );
        const revert = applyOptimisticResolution({ ...annotation, ins_w_id: "8", del_w_id: "7" }, "reject");
        expect(container.querySelectorAll(".docx-edit-hidden")).toHaveLength(2);
        expect(container.querySelector('[data-revision-id="7"]')).toHaveClass("docx-edit-kept");
        revert();
        expect(container.querySelectorAll(".docx-edit-hidden, .docx-edit-kept")).toHaveLength(0);
        expect(container.querySelector('[data-revision-id="8"]')).not.toHaveStyle({ display: "none" });
    });
    beforeEach(() => {
        resolveDocumentEdit.mockReset();
    });

    it("runs the shared View action without making the change text clickable", () => {
        const onViewClick = vi.fn();
        render(
            <EditCard
                changeNumber={3}
                annotation={annotation}
                onViewClick={onViewClick}
            />,
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
        fireEvent.click(screen.getByRole("button", { name: "View" }));
        expect(onViewClick).toHaveBeenCalledWith(annotation);
    });

    it.each([
        ["accept", "Accept", "Accepting...", "Accepted"],
        ["reject", "Reject", "Rejecting...", "Rejected"],
    ] as const)(
        "shows the %s action while the request is pending",
        async (verb, idleLabel, busyLabel, resolvedLabel) => {
            let finish!: (value: unknown) => void;
            resolveDocumentEdit.mockReturnValueOnce(
                new Promise((resolve) => {
                    finish = resolve;
                }),
            );

            render(<EditCard annotation={annotation} />);
            fireEvent.click(
                screen.getByRole("button", { name: idleLabel }),
            );

            expect(
                screen.getByRole("button", { name: busyLabel }),
            ).toBeDisabled();
            expect(
                screen.getByRole("button", {
                    name: verb === "accept" ? "Reject" : "Accept",
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

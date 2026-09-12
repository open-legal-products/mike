import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { QuickActionsModal } from "./QuickActionsModal";
import type { QuickAction } from "../shared/types";

const { listWorkflowsMock } = vi.hoisted(() => ({
    listWorkflowsMock: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: listWorkflowsMock,
}));

const action: QuickAction = {
    id: "quick-action-1",
    user_id: "user-1",
    workflow_id: "workflow-1",
    name: "Proofread agreement",
    prompt: "Review this agreement",
    document_upload: true,
    surface: "app",
    enabled: true,
    sort_order: 0,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
    workflow: { id: "workflow-1", title: "Proofread" },
};

describe("QuickActionsModal", () => {
    beforeEach(() => listWorkflowsMock.mockClear());

    it("only enables Save after an editable field changes", async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
            withIntl(<QuickActionsModal
                open
                actions={[action]}
                onSave={onSave}
                onCreate={vi.fn()}
                onClose={vi.fn()}
            />),
        );

        expect(
            screen.getByRole("button", { name: /Proofread agreement/ }),
        ).toHaveClass("liquid-glass-modal-row-hover");
        expect(
            document.querySelector('[data-slot="quick-actions-list"]'),
        ).toHaveClass("overflow-x-hidden", "px-1", "pt-1");

        fireEvent.click(
            screen.getByRole("button", { name: /Proofread agreement/ }),
        );
        expect(
            document.querySelector('[data-slot="quick-action-form"]'),
        ).not.toHaveClass("overflow-y-auto");
        const save = screen.getByRole("button", { name: "Salvar" });
        expect(save).toBeDisabled();

        fireEvent.change(screen.getByLabelText("Nome"), {
            target: { value: "Proofread contract" },
        });
        expect(save).toBeEnabled();

        fireEvent.click(save);
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith(
                expect.objectContaining({ name: "Proofread contract" }),
            ),
        );
    });
});

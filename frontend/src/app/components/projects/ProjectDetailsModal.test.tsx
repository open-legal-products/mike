import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listOrgs } from "@/app/lib/mikeApi";
import type { Project } from "@/app/components/shared/types";
import { ProjectDetailsModal } from "./ProjectDetailsModal";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listOrgs: vi.fn(),
}));

vi.mock("./ProjectPracticeField", () => ({
    ProjectPracticeField: ({
        id,
        value,
        disabled,
    }: {
        id: string;
        value: string;
        disabled?: boolean;
    }) => (
        <button id={id} type="button" disabled={disabled}>
            {value || "None"}
        </button>
    ),
}));

const project = {
    id: "project-1",
    user_id: "user-1",
    org_id: "org-1",
    name: "Matter",
    cm_number: "CM-123",
    practice: "Litigation",
    memory_enabled: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
} satisfies Project;

describe("ProjectDetailsModal", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listOrgs).mockResolvedValue([
            { id: "org-1", name: "Elite Law LLP" } as never,
        ]);
    });

    it("shows the current organisation in project details", async () => {
        render(
            <ProjectDetailsModal
                open
                project={project}
                canEdit
                onClose={vi.fn()}
                onSave={vi.fn()}
            />,
        );

        const organisation = await screen.findByLabelText("Organisation");
        expect(organisation).toBeDisabled();
        expect(organisation).toHaveTextContent("Elite Law LLP");
    });

    it("requires destructive confirmation before disabling project memory", async () => {
        const user = userEvent.setup();
        const onMemoryEnabledChange = vi.fn().mockResolvedValue(undefined);
        render(
            <ProjectDetailsModal
                open
                project={project}
                canEdit
                onClose={vi.fn()}
                onSave={vi.fn()}
                onMemoryEnabledChange={onMemoryEnabledChange}
            />,
        );

        const memorySwitch = screen.getByRole("switch", {
            name: "Enable project memory",
        });
        expect(memorySwitch).toBeChecked();

        await user.click(memorySwitch);

        expect(onMemoryEnabledChange).not.toHaveBeenCalled();
        expect(screen.getByText("Turn off project memory?")).toBeVisible();
        expect(
            screen.getByText(/permanently deletes the project's memory\.md/),
        ).toBeVisible();

        await user.click(screen.getByRole("button", { name: /Disable/ }));
        await waitFor(() =>
            expect(onMemoryEnabledChange).toHaveBeenCalledWith(false),
        );
        expect(memorySwitch).not.toBeChecked();
    });

    it("keeps the memory setting read-only for viewers", () => {
        render(
            <ProjectDetailsModal
                open
                project={project}
                canEdit={false}
                onClose={vi.fn()}
                onSave={vi.fn()}
                onMemoryEnabledChange={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("switch", { name: "Enable project memory" }),
        ).toBeDisabled();
    });

    it("preserves unsaved detail drafts when the memory setting refreshes", async () => {
        const user = userEvent.setup();
        const onMemoryEnabledChange = vi.fn().mockResolvedValue(undefined);
        const props = {
            open: true,
            canEdit: true,
            onClose: vi.fn(),
            onSave: vi.fn(),
            onMemoryEnabledChange,
        };
        const { rerender } = render(
            <ProjectDetailsModal {...props} project={project} />,
        );

        const name = screen.getByLabelText("Project name");
        await user.clear(name);
        await user.type(name, "Unsaved matter name");
        await user.click(
            screen.getByRole("switch", { name: "Enable project memory" }),
        );
        await user.click(screen.getByRole("button", { name: /Disable/ }));
        await waitFor(() =>
            expect(onMemoryEnabledChange).toHaveBeenCalledWith(false),
        );

        rerender(
            <ProjectDetailsModal
                {...props}
                project={{ ...project, memory_enabled: false }}
            />,
        );

        expect(name).toHaveValue("Unsaved matter name");
    });
});

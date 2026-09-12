import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listOrgs } from "@/app/lib/mikeApi";
import type { Project } from "@/app/components/shared/types";
import { withIntl } from "@/test/withIntl";
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
            withIntl(
                <ProjectDetailsModal
                    open
                    project={project}
                    canEdit
                    onClose={vi.fn()}
                    onSave={vi.fn()}
                />,
            ),
        );

        const organisation = await screen.findByLabelText("Organização");
        expect(organisation).toBeDisabled();
        expect(organisation).toHaveTextContent("Elite Law LLP");
    });
});

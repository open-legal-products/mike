import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectPageHeader } from "./ProjectPageParts";

vi.mock("@/app/components/shared/PageHeader", () => ({
    PageHeader: ({
        breadcrumbs,
        actionGroups,
    }: {
        breadcrumbs?: Array<{ label?: React.ReactNode }>;
        actionGroups?: Array<
            Array<
                | {
                      type?: string;
                      label?: React.ReactNode;
                      title?: string;
                      render?: React.ReactNode;
                  }
                | null
            >
        >;
    }) => (
        <div>
            <div>
                {breadcrumbs?.map((item, index) => (
                    <span key={index}>{item.label}</span>
                ))}
            </div>
            {actionGroups?.flat().map((action, index) => {
                if (!action) return null;
                if (action.type === "custom") {
                    return <div key={index}>{action.render}</div>;
                }
                if (action.type === "search") {
                    return <input key={index} aria-label="Header search" />;
                }
                return (
                    <button key={index} title={action.title}>
                        {action.label}
                    </button>
                );
            })}
        </div>
    ),
}));

vi.mock("@/app/components/shared/HeaderActionsMenu", () => ({
    HeaderActionsMenu: () => <button>More</button>,
}));

vi.mock("@/app/components/shared/DocumentUploadMenu", () => ({
    DocumentUploadMenu: () => <button>Upload</button>,
}));

describe("ProjectPageHeader memory section", () => {
    it("shows the Memory breadcrumb without search or review actions", () => {
        render(
            <ProjectPageHeader
                project={
                    {
                        id: "project-1",
                        name: "Matter",
                    } as never
                }
                search=""
                activeSection="memory"
                creatingChat={false}
                creatingReview={false}
                canManageProject
                onBackToProjects={vi.fn()}
                onProjectRoot={vi.fn()}
                onOpenDetails={vi.fn()}
                onDeleteProject={vi.fn()}
                onSearchChange={vi.fn()}
                onOpenAccess={vi.fn()}
                onNewChat={vi.fn()}
                onNewReview={vi.fn()}
            />,
        );

        expect(screen.getByText("Memory")).toBeVisible();
        expect(screen.queryByLabelText("Header search")).toBeNull();
        expect(screen.queryByTitle("Create review")).toBeNull();
        expect(screen.queryByTitle("Create chat")).toBeNull();
    });
});

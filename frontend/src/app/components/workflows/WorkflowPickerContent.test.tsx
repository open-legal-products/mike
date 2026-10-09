import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowPickerContent } from "./WorkflowPickerContent";

const workflow: Workflow = {
    id: "workflow-1",
    user_id: "user-1",
    metadata: {
        title: "Review agreement",
        description: null,
        type: "assistant",
        contributors: [],
        language: "English",
        version: null,
        practice: "Commercial",
        jurisdictions: null,
    },
    skill_md: "Review the agreement.",
    columns_config: null,
    is_system: true,
    created_at: "2026-08-18T00:00:00Z",
};

const commonProps = {
    workflows: [workflow],
    onSelect: vi.fn(),
    search: "",
    onSearchChange: vi.fn(),
};

describe("WorkflowPickerContent row labels", () => {
    it("shows practice instead of the legacy system/custom label", () => {
        render(<WorkflowPickerContent {...commonProps} selected={null} />);

        expect(
            screen.getByRole("button", { name: /Review agreement/ }),
        ).toHaveClass("liquid-glass-modal-row-hover");
        expect(
            document.querySelector('[data-slot="workflow-picker-list"]'),
        ).toHaveClass("overflow-x-hidden");
        expect(screen.getByText("Commercial")).toBeInTheDocument();
        expect(screen.queryByText("System")).not.toBeInTheDocument();
        expect(screen.queryByText("Custom")).not.toBeInTheDocument();
    });

    it("hides practice while the workflow details panel is shown", () => {
        Element.prototype.scrollIntoView = vi.fn();
        render(<WorkflowPickerContent {...commonProps} selected={workflow} />);

        expect(screen.queryByText("Commercial")).not.toBeInTheDocument();
    });

    it("shows a prompt skeleton instead of an empty-prompt message while loading", () => {
        Element.prototype.scrollIntoView = vi.fn();
        render(
            <WorkflowPickerContent
                {...commonProps}
                selected={{ ...workflow, skill_md: null }}
                previewLoading
            />,
        );

        expect(
            screen.getByRole("status", { name: "Loading workflow prompt" }),
        ).toBeInTheDocument();
        expect(screen.queryByText("No prompt defined.")).not.toBeInTheDocument();
    });
});

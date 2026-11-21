import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowSlashCommandUI, workflowSlashCommandFromTitle } from "./WorkflowSlashCommandUI";

describe("WorkflowSlashCommandUI", () => {
    it("shows the title-derived command and activation caption", () => {
        render(<WorkflowSlashCommandUI title="Contract & Intake 2026!" />);

        const command = screen.getByText("/contract-intake-2026");
        expect(command).toBeInTheDocument();
        expect(command).toHaveClass("text-gray-700");
        expect(command).not.toHaveClass("font-mono", "font-medium");
        expect(command.parentElement).toHaveTextContent(
            "Type /contract-intake-2026 in chat to activate this workflow.",
        );
    });

    it("reserves empty caption space when the title is empty", () => {
        const { container } = render(<WorkflowSlashCommandUI title="" />);

        const caption = container.querySelector("p");
        expect(caption).toHaveClass("min-h-5", "text-xs", "text-gray-500");
        expect(caption).toHaveTextContent("");
        expect(screen.queryByText(/activate this workflow/)).not.toBeInTheDocument();
    });

    it("trims edge hyphens from the slug, in linear time", () => {
        expect(workflowSlashCommandFromTitle("  -- Due -- diligence --  ")).toBe("/due-diligence");
        expect(workflowSlashCommandFromTitle("---")).toBeNull();
        // A long run of "-" followed by anything else is the input CodeQL
        // names for /-+$/ (V8 happens to run the old alternation fast).
        const started = performance.now();
        expect(workflowSlashCommandFromTitle(`${"-".repeat(100_000)}x`)).toBe("/x");
        expect(performance.now() - started).toBeLessThan(1_000);
    });
});

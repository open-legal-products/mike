import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageHeader } from "./PageHeader";
import { PageSheet, useOnPageSheet } from "./PageSheet";
import { PAGE_HEADER_SHEET_ROW_CLASS } from "./pageHeaderStyles";
import { TableScrollArea } from "./TablePrimitive";
import { TableToolbar } from "./TableToolbar";

vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
    })),
);

function Probe() {
    return <span>{useOnPageSheet() ? "on sheet" : "off sheet"}</span>;
}

describe("PageSheet", () => {
    it("is one glass sheet in the sidebar's material, telling what is inside it so", () => {
        const { container } = render(
            <>
                <PageSheet>
                    <Probe />
                </PageSheet>
                <Probe />
            </>,
        );
        expect(container.firstElementChild).toHaveAttribute(
            "data-slot",
            "page-sheet",
        );
        // A sheet only from md up: inset and rounded there, the window's
        // own page below (globals.css clears the material).
        expect(container.firstElementChild).toHaveClass(
            "liquid-glass-float",
            "md:rounded-2xl",
            "md:my-3",
            "md:ml-2",
            "md:mr-3",
        );
        expect(container.firstElementChild).not.toHaveClass(
            "rounded-2xl",
            "my-2",
        );
        expect(screen.getByText("on sheet")).toBeInTheDocument();
        expect(screen.getByText("off sheet")).toBeInTheDocument();
    });

    it("drops the page's own margins from the header, toolbar and table on it", () => {
        render(
            <PageSheet>
                <PageHeader>
                    <h1>Projects</h1>
                </PageHeader>
                <TableToolbar items={[{ id: "all", label: "All" }]} active="all" />
                <TableScrollArea>
                    <div>Rows</div>
                </TableScrollArea>
            </PageSheet>,
        );

        const header = screen.getByRole("heading", { name: "Projects" })
            .parentElement!;
        expect(header).toHaveClass(...PAGE_HEADER_SHEET_ROW_CLASS.split(" "));
        expect(header).not.toHaveClass("min-h-[76px]", "md:mx-5");

        const toolbar = screen.getByRole("button", { name: "All" })
            .parentElement!.parentElement!;
        // Below md there is no sheet: both keep the top bar's 16px there.
        expect(toolbar).toHaveClass("mx-4", "md:mx-3");
        expect(toolbar).not.toHaveClass("md:mx-6");

        const table = screen.getByText("Rows").closest(".table-surface")!
            .parentElement!;
        expect(table).toHaveClass("mx-[3px]", "md:mx-0", "md:mb-0");
        expect(table).not.toHaveClass("md:mx-[11px]", "md:mb-3");
    });

    it("runs a table with grid lines to the sheet's edges from md up, and keeps its card below", () => {
        render(
            <PageSheet>
                <TableScrollArea preserveGridBorder>
                    <div>Rows</div>
                </TableScrollArea>
            </PageSheet>,
        );
        const table = screen.getByText("Rows").closest(".table-surface")!
            .parentElement!;
        expect(table).toHaveClass("md:mx-0", "md:mb-0", "md:rounded-none");
        expect(table).toHaveClass("mx-4", "mb-2", "rounded-2xl");
    });

    it("clears the sheet below md and backs the table's sticky cells with its fill above", () => {
        const css = readFileSync(
            resolve(__dirname, "../../globals.css"),
            "utf8",
        );
        expect(css).toMatch(
            /@media \(width < 48rem\) \{\s*\[data-slot="page-sheet"\] \{\s*border-color: transparent;\s*background-color: transparent;\s*box-shadow: none;/,
        );
        expect(css).toMatch(
            /@media \(width >= 48rem\) \{\s*\[data-slot="page-sheet"\] \.table-surface \{\s*--table-cell-background: var\(--liquid-glass-background-float\);/,
        );
        // On the sheet, a grid table has no side or foot lines, and playbook
        // panes have no cards.
        expect(css).toMatch(
            /\[data-slot="page-sheet"\] \.table-surface\.tabular-review-table-surface \{\s*border-right-width: 0;\s*border-bottom-width: 0;\s*border-left-width: 0;\s*border-radius: 0;/,
        );
        expect(css).toMatch(
            /\[data-slot="page-sheet"\] \.playbook-pane \{\s*border-color: transparent;\s*border-radius: 0;\s*background-color: transparent;\s*box-shadow: none;/,
        );
    });

    // Every page with a table sits on a sheet. Each of these renders its page
    // header (or, for a project, the shell its pages share) inside one, so a
    // new wrapper cannot quietly take a page off it.
    it.each([
        "app/(pages)/tabular-reviews/page.tsx",
        "app/components/projects/ProjectsOverview.tsx",
        "app/components/projects/ProjectWorkspace.tsx",
        "app/components/tabular/TabularReviewView.tsx",
        "app/components/workflows/WorkflowList.tsx",
        "app/components/workflows/WorkflowDetailPage.tsx",
        "app/components/playbooks/PlaybooksWorkspace.tsx",
        "app/components/library/LibraryWorkspace.tsx",
        "app/components/library/PresetTemplatesPage.tsx",
        "app/components/organizations/OrganizationMembers.tsx",
        "app/components/history/AuditHistory.tsx",
    ])("puts %s on a sheet", (file) => {
        const source = readFileSync(resolve(__dirname, "../../..", file), "utf8");
        const headers = source.match(/<(PageHeader|ProjectPageHeader)\b/g) ?? [];
        const sheets = source.match(/<PageSheet\b/g) ?? [];
        expect(sheets.length).toBeGreaterThan(0);
        expect(sheets.length).toBeGreaterThanOrEqual(headers.length);
    });
});

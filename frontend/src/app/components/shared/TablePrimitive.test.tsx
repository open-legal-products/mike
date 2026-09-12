import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import {
    SkeletonCheckbox,
    TableFilters,
    TableHeaderRow,
    TableStickyCell,
    TableScrollArea,
    TablePrimaryCell,
    rowActionSelectionIds,
    selectionAnchorAfterRowSelection,
    selectionRangeIds,
    selectedIdsAfterRangeClick,
    selectedIdsAfterShiftClick,
    tableTreeCellStyle,
} from "./TablePrimitive";

describe("table row actions", () => {
    it("targets the full selection when the context row is selected", () => {
        expect(rowActionSelectionIds("row-2", ["row-1", "row-2"])).toEqual([
            "row-1",
            "row-2",
        ]);
    });
    it("targets only an unselected context row", () => {
        expect(rowActionSelectionIds("row-3", ["row-1", "row-2"])).toEqual([
            "row-3",
        ]);
    });

    it("adds a shift-clicked row without clearing the selection", () => {
        expect(
            selectedIdsAfterShiftClick("row-3", ["row-1", "row-2"]),
        ).toEqual(["row-1", "row-2", "row-3"]);
        expect(
            selectedIdsAfterShiftClick("row-2", ["row-1", "row-2"]),
        ).toEqual(["row-1", "row-2"]);
    });

    it("adds the inclusive range between shift-clicked rows", () => {
        expect(
            selectedIdsAfterRangeClick(
                "row-4",
                ["row-1", "row-2", "row-3", "row-4"],
                ["row-1"],
                "row-2",
            ),
        ).toEqual(["row-1", "row-2", "row-3", "row-4"]);
        expect(
            selectedIdsAfterRangeClick(
                "row-2",
                ["row-1", "row-2"],
                [],
                null,
            ),
        ).toEqual(["row-2"]);
    });

    it("ranges across interleaved file and folder row keys", () => {
        expect(
            selectionRangeIds(
                [
                    "document:file-1",
                    "folder:folder-1",
                    "document:file-2",
                    "folder:folder-2",
                ],
                "folder:folder-1",
                "folder:folder-2",
            ),
        ).toEqual([
            "folder:folder-1",
            "document:file-2",
            "folder:folder-2",
        ]);
    });

    it("does not reuse a row as the shift anchor after it is deselected", () => {
        const rowKeys = [
            "document:row-1",
            "document:row-2",
            "document:row-3",
            "document:row-4",
            "document:row-5",
        ];
        let anchor = selectionAnchorAfterRowSelection(
            null,
            "document:row-1",
            ["document:row-1"],
            true,
        );

        anchor = selectionAnchorAfterRowSelection(
            anchor,
            "document:row-1",
            ["document:row-1"],
            false,
        );

        expect(anchor).toBeNull();
        expect(
            selectionRangeIds(rowKeys, anchor, "document:row-5"),
        ).toEqual(["document:row-5"]);
    });
});

describe("table filters", () => {
    it("marks the current option with the shared dropdown selected state", async () => {
        const user = userEvent.setup();
        render(
            <TableFilters
                label="Filter by file type"
                value="pdf"
                allLabel="All file types"
                options={[
                    { value: "pdf", label: "PDF" },
                    { value: "docx", label: "Word" },
                ]}
                onChange={vi.fn()}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "Filter by file type" }),
        );

        expect(screen.getByRole("menuitem", { name: "PDF" })).toHaveAttribute(
            "data-selected",
            "true",
        );
        expect(
            screen.getByRole("menuitem", { name: "All file types" }),
        ).not.toHaveAttribute("data-selected");
    });
});

describe("table skeletons", () => {
    it("uses the same geometry as a table checkbox", () => {
        const { container } = render(<SkeletonCheckbox />);

        expect(container.firstChild).toHaveClass(
            "mr-3",
            "h-2.5",
            "w-2.5",
            "shrink-0",
        );
    });
});

describe("table surface", () => {
    it("uses high-contrast text for header labels", () => {
        render(<TableHeaderRow>Header</TableHeaderRow>);

        expect(screen.getByText("Header")).toHaveClass("text-gray-700");
        expect(screen.getByText("Header")).not.toHaveClass(
            "backdrop-blur-xl",
        );
    });

    it("uses the table surface without a persistent liquid-glass class", () => {
        const { container } = render(
            <TableScrollArea>
                <div>Rows</div>
            </TableScrollArea>,
        );

        const surface = container.querySelector(".table-surface");
        expect(surface).not.toBeNull();
        expect(surface).not.toHaveClass("liquid-glass-subtle");
        expect(surface).not.toHaveClass("liquid-glass-flat");
        expect(surface).not.toHaveClass("tabular-review-table-surface");
    });

    it("marks tabular review surfaces so their grid border is preserved", () => {
        const { container } = render(
            <TableScrollArea preserveGridBorder>
                <div>Rows</div>
            </TableScrollArea>,
        );

        expect(container.querySelector(".table-surface")).toHaveClass(
            "tabular-review-table-surface",
        );
    });

    it("renders viewport overlays outside the scrolling content", () => {
        render(
            <TableScrollArea
                viewportOverlay={<div data-testid="viewport-overlay" />}
            >
                <div>Rows</div>
            </TableScrollArea>,
        );

        const rows = screen.getByText("Rows");
        const scrollViewport = rows.parentElement;
        const overlay = screen.getByTestId("viewport-overlay");

        expect(scrollViewport).toHaveClass("overflow-auto");
        expect(scrollViewport).not.toContainElement(overlay);
        expect(overlay.parentElement).toBe(scrollViewport?.parentElement);
        expect(overlay.parentElement).toHaveClass("relative");
    });

    it("keeps the sticky header and rows in the same scroll viewport", () => {
        render(
            <TableScrollArea header={<div>Header</div>}>
                <div>Rows</div>
            </TableScrollArea>,
        );

        const rows = screen.getByText("Rows");
        const header = screen.getByText("Header");
        const scrollViewport = rows.parentElement;

        expect(scrollViewport).toHaveClass("overflow-auto");
        expect(scrollViewport).toContainElement(header);
        expect(header.parentElement).toHaveClass(
            "table-sticky-header",
            "sticky",
            "top-0",
            "w-max",
            "min-w-full",
        );
    });

    it("marks sticky columns for an opaque app-background fallback", () => {
        render(<TableStickyCell>Sticky</TableStickyCell>);

        expect(screen.getByText("Sticky")).toHaveClass("table-sticky-cell");
    });

    it("marks sticky header cells with the first-column surface", () => {
        render(<TableStickyCell header>Header</TableStickyCell>);

        expect(screen.getByText("Header")).toHaveClass("table-sticky-cell");
    });
});

describe("table tree indentation", () => {
    it("centers each child checkbox beneath its parent chevron", () => {
        expect(tableTreeCellStyle(1)).toEqual({ paddingLeft: 37 });
        expect(tableTreeCellStyle(2)).toEqual({ paddingLeft: 62 });
    });

    it("applies tree indentation to primary cells", () => {
        render(
            withIntl(
                <TablePrimaryCell
                    label="Nested workflow"
                    selected={false}
                    onSelectionChange={vi.fn()}
                    style={tableTreeCellStyle(1)}
                />,
            ),
        );

        expect(
            screen.getByRole("checkbox", {
                name: "Selecionar Nested workflow",
            }).parentElement?.parentElement,
        ).toHaveStyle({ paddingLeft: "37px" });
    });
});

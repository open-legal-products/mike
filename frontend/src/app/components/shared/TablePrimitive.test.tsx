import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
    SkeletonCheckbox,
    TableFilters,
    TableScrollArea,
    TablePrimaryCell,
    rowActionSelectionIds,
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
    it("uses the flat liquid-glass tier", () => {
        const { container } = render(
            <TableScrollArea>
                <div>Rows</div>
            </TableScrollArea>,
        );

        expect(container.querySelector(".liquid-glass-flat")).not.toBeNull();
    });
});

describe("table tree indentation", () => {
    it("centers each child checkbox beneath its parent chevron", () => {
        expect(tableTreeCellStyle(1)).toEqual({ paddingLeft: 37 });
        expect(tableTreeCellStyle(2)).toEqual({ paddingLeft: 62 });
    });

    it("applies tree indentation to primary cells", () => {
        render(
            <TablePrimaryCell
                label="Nested workflow"
                selected={false}
                onSelectionChange={vi.fn()}
                style={tableTreeCellStyle(1)}
            />,
        );

        expect(
            screen.getByRole("checkbox", {
                name: "Select Nested workflow",
            }).parentElement?.parentElement,
        ).toHaveStyle({ paddingLeft: "37px" });
    });
});

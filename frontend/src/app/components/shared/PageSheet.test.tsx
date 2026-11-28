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
        expect(container.firstElementChild).toHaveClass(
            "liquid-glass-float",
            "rounded-2xl",
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
        expect(toolbar).toHaveClass("mx-3");
        expect(toolbar).not.toHaveClass("md:mx-5");

        const table = screen.getByText("Rows").closest(".table-surface")!
            .parentElement!;
        expect(table).not.toHaveClass("mx-3", "md:mx-5", "mb-2", "md:mb-3");
    });

    it("backs the table's sticky cells with the sheet's fill, not the page's", () => {
        const css = readFileSync(
            resolve(__dirname, "../../globals.css"),
            "utf8",
        );
        expect(css).toMatch(
            /\[data-slot="page-sheet"\] \.table-surface \{\s*--table-cell-background: var\(--liquid-glass-background-float\);/,
        );
    });
});

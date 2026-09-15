import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Workbook, type WorkbookInstance } from "@fortune-sheet/react";
import type { Sheet } from "@fortune-sheet/core";
import {
    SpreadsheetWorkbook,
    type SpreadsheetSession,
} from "./SpreadsheetWorkbook";

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
        function (this: HTMLElement) {
            return this.classList.contains("fortune-sheet-canvas-placeholder")
                ? 400
                : 0;
        },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        function (this: HTMLCanvasElement) {
            return new Proxy(
                {
                    canvas: this,
                    measureText: () => ({ width: 10 }),
                    getImageData: () => ({
                        data: new Uint8ClampedArray(4),
                        width: 1,
                        height: 1,
                    }),
                },
                {
                    get: (target, key) =>
                        key in target
                            ? target[key as keyof typeof target]
                            : vi.fn(),
                },
            ) as unknown as CanvasRenderingContext2D;
        },
    );
});
afterEach(() => vi.restoreAllMocks());

it.each([0.7, 1, 1.5])(
    "ends the vertical scroll range at the last row above the scrollbar at %s zoom",
    async (zoomRatio) => {
        const sheets: Sheet[] = [
            {
                id: "s1",
                name: "Budget",
                status: 1,
                images: [],
                row: 100,
                column: 5,
                zoomRatio,
                defaultRowHeight: 19,
                data: [[{ v: "Budget" }]],
            },
        ];
        const { container } = render(
            <SpreadsheetWorkbook
                Workbook={Workbook}
                sheets={sheets}
                hooks={{}}
                workbookRef={createRef<WorkbookInstance>()}
                sessionRef={createRef<SpreadsheetSession>()}
            />,
        );
        await screen.findByText(`${zoomRatio * 100}%`);
        const spacer = container.querySelector<HTMLElement>(
            ".luckysheet-scrollbar-y > div",
        )!;
        // The canvas includes the column header. Leave only the 8px horizontal scrollbar
        // after the last row so that the final cell remains fully visible at the bottom.
        const rowCount = sheets[0].row!;
        await waitFor(() =>
            expect(Number.parseFloat(spacer.style.height)).toBe(
                rowCount * Math.round(20 * zoomRatio) + 20 * zoomRatio + 8,
            ),
        );
    },
);

it("scales row-number and column-letter headers with zoom buttons and keyboard zoom without remounting", async () => {
    const sheets: Sheet[] = [
        {
            id: "s1",
            name: "Budget",
            status: 1,
            images: [],
            row: 10,
            column: 5,
            data: [
                [{ v: "Budget", m: "Budget", ct: { fa: "General", t: "g" } }],
            ],
        },
    ];
    const workbookRef = createRef<WorkbookInstance>();
    const sessionRef = createRef<SpreadsheetSession>();
    const { container } = render(
        <SpreadsheetWorkbook
            Workbook={Workbook}
            sheets={sheets}
            hooks={{}}
            workbookRef={workbookRef}
            sessionRef={sessionRef}
        />,
    );
    await screen.findByText("100%");
    const corner = container.querySelector<HTMLElement>(".fortune-left-top")!;
    const rowWidth = Number.parseFloat(corner.style.width) + 1.5;
    const columnHeight = Number.parseFloat(corner.style.height) + 1.5;
    const spacer = container.querySelector<HTMLElement>(
        ".luckysheet-scrollbar-y > div",
    )!;
    expect(rowWidth).toBeGreaterThan(0);
    expect(columnHeight).toBeGreaterThan(0);
    await waitFor(() =>
        expect(Number.parseFloat(spacer.style.height)).toBe(228),
    );

    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    await screen.findByText("110%");
    await waitFor(() => {
        expect(Number.parseFloat(corner.style.width) + 1.5).toBeCloseTo(
            rowWidth * 1.1,
        );
        expect(Number.parseFloat(corner.style.height) + 1.5).toBeCloseTo(
            columnHeight * 1.1,
        );
        expect(Number.parseFloat(spacer.style.height)).toBe(250);
    });
    fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));
    await screen.findByText("100%");
    await waitFor(() => {
        expect(Number.parseFloat(corner.style.width) + 1.5).toBeCloseTo(
            rowWidth,
        );
        expect(Number.parseFloat(corner.style.height) + 1.5).toBeCloseTo(
            columnHeight,
        );
        expect(Number.parseFloat(spacer.style.height)).toBe(228);
    });
    fireEvent.keyDown(document, { key: "-", ctrlKey: true });
    await screen.findByText("90%");
    await waitFor(() => {
        expect(Number.parseFloat(corner.style.width) + 1.5).toBeCloseTo(
            rowWidth * 0.9,
        );
        expect(Number.parseFloat(corner.style.height) + 1.5).toBeCloseTo(
            columnHeight * 0.9,
        );
        expect(Number.parseFloat(spacer.style.height)).toBe(206);
    });
    expect(container.querySelector(".fortune-left-top")).toBe(corner);
});

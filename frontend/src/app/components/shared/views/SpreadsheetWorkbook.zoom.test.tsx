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
    expect(rowWidth).toBeGreaterThan(0);
    expect(columnHeight).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    await screen.findByText("110%");
    await waitFor(() => {
        expect(Number.parseFloat(corner.style.width) + 1.5).toBeCloseTo(
            rowWidth * 1.1,
        );
        expect(Number.parseFloat(corner.style.height) + 1.5).toBeCloseTo(
            columnHeight * 1.1,
        );
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
    });
    expect(container.querySelector(".fortune-left-top")).toBe(corner);
});

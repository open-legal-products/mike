"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import LuckyExcel, { type LuckyExcelSheet } from "luckyexcel";
import type { WorkbookInstance } from "@fortune-sheet/react";
import type { Cell, Sheet } from "@fortune-sheet/core";
import "@fortune-sheet/react/dist/index.css";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import { normalizeSpreadsheetImages } from "@/app/lib/spreadsheetImages";
import {
    SpreadsheetWorkbook,
    type SpreadsheetSession,
} from "./SpreadsheetWorkbook";

type HighlightRange = { row: [number, number]; column: [number, number] };
type WorkbookComponent = typeof import("@fortune-sheet/react").Workbook;

/** A cell locator to highlight, e.g. { sheet: "Q3 Budget", cell: "B7" }. */
export type HighlightCell = { sheet?: string; cell?: string };

interface Props {
    documentId: string;
    versionId?: string | null;
    displayUrl?: string | null;
    refetchKey?: number | string;
    /** Cell(s) to select/scroll to (from a spreadsheet citation). */
    highlightCells?: HighlightCell[];
    rounded?: boolean;
    active?: boolean;
}

/** "B" -> 1, "AA" -> 26 (0-based column index). */
function columnLettersToIndex(letters: string): number {
    let n = 0;
    for (const ch of letters.toUpperCase()) {
        n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
}

/** Parse an A1 address like "B7" into 0-based { r, c }. */
function parseA1(cell: string): { r: number; c: number } | null {
    const m = cell.trim().match(/^([A-Za-z]+)(\d+)$/);
    if (!m) return null;
    const c = columnLettersToIndex(m[1]);
    const r = Number.parseInt(m[2], 10) - 1;
    if (c < 0 || r < 0) return null;
    return { r, c };
}

/** Parse an A1 address or range ("B7" or "B7:C9") into 0-based row/col spans. */
function parseRange(range: string): HighlightRange | null {
    const [startRaw, endRaw] = range.split(":");
    const start = parseA1(startRaw);
    if (!start) return null;
    const end = endRaw ? parseA1(endRaw) : start;
    if (!end) return null;
    return {
        row: [Math.min(start.r, end.r), Math.max(start.r, end.r)],
        column: [Math.min(start.c, end.c), Math.max(start.c, end.c)],
    };
}

/**
 * Expand a highlight range to cover any merged ranges it intersects. Fortune-
 * sheet paints a merge as one block anchored at its top-left cell and never
 * paints the covered cells, so a citation to a covered cell (e.g. B1 inside
 * A1:C1) would otherwise highlight nothing. The model is asked to cite the full
 * merged range, but this is a deterministic fallback for when it cites a covered
 * cell anyway. Expanding to the anchor makes `afterRenderCell` paint the block.
 */
function expandRangeForMerges(
    sheet: Sheet,
    range: HighlightRange,
): HighlightRange {
    const merges = (sheet.config as { merge?: Record<string, MergeInfo> })
        ?.merge;
    if (!merges) return range;
    let [r0, r1] = range.row;
    let [c0, c1] = range.column;
    for (const m of Object.values(merges)) {
        const mr1 = m.r + m.rs - 1;
        const mc1 = m.c + m.cs - 1;
        if (r0 <= mr1 && r1 >= m.r && c0 <= mc1 && c1 >= m.c) {
            r0 = Math.min(r0, m.r);
            r1 = Math.max(r1, mr1);
            c0 = Math.min(c0, m.c);
            c1 = Math.max(c1, mc1);
        }
    }
    return { row: [r0, r1], column: [c0, c1] };
}

/**
 * Pixel offset (from the grid origin) and size of a row/col span, derived from
 * the sheet's column widths / row heights. Fortune-sheet defaults are 73px wide
 * and 19px tall; per-index overrides live in `config.columnlen`/`config.rowlen`.
 * Hidden rows/cols aren't accounted for, so this is best-effort (enough to
 * decide whether the cell is on screen and where to center it).
 */
function rangePixelRect(
    sheet: Sheet,
    range: HighlightRange,
): { x: number; y: number; w: number; h: number } {
    const cfg = (sheet.config ?? {}) as {
        columnlen?: Record<string, number>;
        rowlen?: Record<string, number>;
    };
    const colLen = cfg.columnlen ?? {};
    const rowLen = cfg.rowlen ?? {};
    const colW = (c: number) => colLen[c] ?? sheet.defaultColWidth ?? 73;
    const rowH = (r: number) => rowLen[r] ?? sheet.defaultRowHeight ?? 19;

    let x = 0;
    for (let c = 0; c < range.column[0]; c++) x += colW(c);
    let w = 0;
    for (let c = range.column[0]; c <= range.column[1]; c++) w += colW(c);
    let y = 0;
    for (let r = 0; r < range.row[0]; r++) y += rowH(r);
    let h = 0;
    for (let r = range.row[0]; r <= range.row[1]; r++) h += rowH(r);
    return { x, y, w, h };
}

type MergeInfo = { r: number; c: number; rs: number; cs: number };
type CellData = { r: number; c: number; v: Record<string, unknown> };

/**
 * Expand `config.merge` onto the cells. Luckyexcel records merges in
 * `config.merge` but Fortune-sheet only renders a merge when the cells carry
 * `mc` (the anchor gets `{r,c,rs,cs}`; every covered cell points back with
 * `{r,c}`). Without this, merged ranges render as separate single cells.
 */
function applyMergeCells(sheets: LuckyExcelSheet[]): void {
    for (const sheet of sheets) {
        const merges = (sheet.config as { merge?: Record<string, MergeInfo> })
            ?.merge;
        if (!merges) continue;

        if (!Array.isArray(sheet.celldata)) sheet.celldata = [];
        const celldata = sheet.celldata as CellData[];

        const byKey = new Map<string, CellData>();
        for (const entry of celldata) {
            if (typeof entry?.r === "number" && typeof entry?.c === "number") {
                byKey.set(`${entry.r}_${entry.c}`, entry);
            }
        }
        const ensureCell = (r: number, c: number): CellData => {
            const key = `${r}_${c}`;
            let entry = byKey.get(key);
            if (!entry) {
                entry = { r, c, v: {} };
                celldata.push(entry);
                byKey.set(key, entry);
            }
            if (!entry.v || typeof entry.v !== "object") entry.v = {};
            return entry;
        };

        for (const mc of Object.values(merges)) {
            ensureCell(mc.r, mc.c).v.mc = {
                r: mc.r,
                c: mc.c,
                rs: mc.rs,
                cs: mc.cs,
            };
            for (let rr = mc.r; rr < mc.r + mc.rs; rr++) {
                for (let cc = mc.c; cc < mc.c + mc.cs; cc++) {
                    if (rr === mc.r && cc === mc.c) continue;
                    ensureCell(rr, cc).v.mc = { r: mc.r, c: mc.c };
                }
            }
        }
    }
}

/**
 * Make text cells overflow into empty adjacent cells, mirroring Excel's default.
 * Fortune-sheet only spills a cell's text when its `tb` (text-break) is "1";
 * Luckyexcel leaves text cells clipping, so we set `tb: "1"` on unwrapped,
 * non-merged text cells. Fortune-sheet still only paints the overflow over
 * genuinely empty neighbors, so this matches Excel (numbers/dates keep the
 * default and are not spilled).
 */
function applyExcelTextOverflow(sheets: LuckyExcelSheet[]): void {
    for (const sheet of sheets) {
        const celldata = sheet.celldata;
        if (!Array.isArray(celldata)) continue;
        for (const entry of celldata) {
            const cell = (entry as { v?: Record<string, unknown> } | null)?.v;
            if (!cell || typeof cell !== "object") continue;
            if (cell.mc) continue; // part of a merge - leave as-is
            if (cell.tb === "2") continue; // explicit wrap-text - keep
            if (typeof cell.v === "string" && cell.v.length > 0) {
                cell.tb = "1"; // text: overflow into empty neighbors
            }
        }
    }
}

/**
 * Tint a row/column header cell gray via Fortune-sheet's own header render
 * hooks. Fortune-sheet paints the header labels (A/B/C, 1/2/3) onto the grid
 * canvas with a white fill and dark text; we lay a translucent gray over that
 * cell in the `afterRender…HeaderCell` pass. A low alpha darkens the white
 * background into gray while leaving the dark labels legible — unlike an opaque
 * CSS background on the header overlay divs, which sits in front of the canvas
 * and hides the labels entirely.
 */
function canvasThemeColor(
    ctx: CanvasRenderingContext2D,
    property: string,
): string | null {
    return (
        getComputedStyle(ctx.canvas).getPropertyValue(property).trim() || null
    );
}

function tintHeaderCell(
    x: number,
    y: number,
    width: number,
    height: number,
    ctx: CanvasRenderingContext2D,
): void {
    const tint = canvasThemeColor(ctx, "--spreadsheet-header-tint");
    if (!tint) return;
    ctx.save();
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, width, height);
    ctx.restore();
}

/**
 * Renders an Excel workbook as a read-only grid using Fortune-sheet. It fetches
 * the document's raw `.xlsx`/`.xlsm`/`.xls` bytes itself (via /display) and
 * converts them to Fortune-sheet data with Luckyexcel, preserving the original
 * styling (fills, fonts, borders, merges).
 *
 * Spreadsheet citations are highlighted by cell: `highlightCells` activates the
 * cited sheet tab and scrolls the A1 address/range into view, where a canvas
 * hook paints the highlight.
 */
export function SpreadsheetView({
    documentId,
    versionId,
    displayUrl,
    refetchKey,
    highlightCells,
    rounded = true,
    active = true,
}: Props) {
    const workbookRef = useRef<WorkbookInstance>(null);
    const [session, setSession] = useState<SpreadsheetSession | null>(null);
    // The frame element, used to reach Fortune-sheet's scrollbars for measuring
    // the current scroll offset and viewport size when deciding whether to scroll.
    const containerRef = useRef<HTMLDivElement>(null);
    // Current highlight, read by the render hook. A ref (not state) so updating
    // it never re-mounts the Workbook or changes the settings object.
    const highlightRef = useRef<HighlightRange | null>(null);
    const [sheets, setSheets] = useState<Sheet[] | null>(null);
    const [workbookGeneration, setWorkbookGeneration] = useState(0);
    const [WorkbookComponent, setWorkbookComponent] =
        useState<WorkbookComponent | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Fetch the raw workbook bytes. For spreadsheets, /display returns the
    // original .xlsx/.xlsm/.xls bytes rather than a PDF rendition.
    const { result, error: fetchError } = useFetchSingleDoc(
        documentId,
        versionId,
        displayUrl,
        refetchKey,
    );

    // Fortune-sheet touches browser-only APIs while loading, so keep the import
    // inside the client component even though this file also owns the view.
    useEffect(() => {
        let cancelled = false;
        import("@fortune-sheet/react").then((mod) => {
            if (!cancelled) setWorkbookComponent(() => mod.Workbook);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    // Stable key so the highlight effect only re-runs when the target changes.
    const highlightKey = useMemo(
        () =>
            (highlightCells ?? [])
                .map((h) => `${h.sheet ?? ""}!${h.cell ?? ""}`)
                .join("|"),
        [highlightCells],
    );

    // Parse the workbook with Luckyexcel, which converts the .xlsx to
    // Fortune-sheet data while preserving styling (fills, fonts, borders,
    // alignment, column widths).
    useEffect(() => {
        if (!result) return;
        if (result.type !== "spreadsheet") {
            setError("This spreadsheet could not be displayed.");
            return;
        }
        let cancelled = false;
        setSheets(null);
        setError(null);

        try {
            const file = new File([result.buffer], "spreadsheet.xlsx");
            LuckyExcel.transformExcelToLucky(file, (exportJson) => {
                if (cancelled) return;
                if (exportJson?.sheets?.length) {
                    applyMergeCells(exportJson.sheets);
                    applyExcelTextOverflow(exportJson.sheets);
                    for (const sheet of exportJson.sheets) {
                        sheet.images = normalizeSpreadsheetImages(sheet.images);
                    }
                    setSheets(exportJson.sheets as unknown as Sheet[]);
                    setWorkbookGeneration((generation) => generation + 1);
                } else {
                    setError("This spreadsheet could not be displayed.");
                }
            });
        } catch {
            if (!cancelled)
                setError("This spreadsheet could not be displayed.");
        }

        return () => {
            cancelled = true;
        };
    }, [result]);

    // Draw the citation highlight on the canvas. Stable identity so the Workbook
    // settings never change; it reads the live target from `highlightRef`. We use
    // this instead of `setSelection`, whose in-place mutation of the range object
    // crashes under React Strict Mode's double-invoked immer producer.
    const afterRenderCell = useCallback(
        (
            _cell: Cell | null,
            info: {
                row: number;
                column: number;
                startX: number;
                startY: number;
                endX: number;
                endY: number;
            },
            ctx: CanvasRenderingContext2D,
        ) => {
            const range = highlightRef.current;
            if (!range) return;
            if (
                info.row < range.row[0] ||
                info.row > range.row[1] ||
                info.column < range.column[0] ||
                info.column > range.column[1]
            ) {
                return;
            }
            const w = info.endX - info.startX;
            const h = info.endY - info.startY;
            const fill = canvasThemeColor(
                ctx,
                "--spreadsheet-highlight-background",
            );
            const outline = canvasThemeColor(
                ctx,
                "--spreadsheet-highlight-outline",
            );
            if (!fill || !outline) return;
            ctx.save();
            ctx.fillStyle = fill;
            ctx.fillRect(info.startX, info.startY, w, h);
            ctx.strokeStyle = outline;
            ctx.lineWidth = 2;
            ctx.strokeRect(info.startX + 1, info.startY + 1, w - 2, h - 2);
            ctx.restore();
        },
        [],
    );
    const hooks = useMemo(
        () => ({
            afterRenderCell,
            // Tint the header strips gray while keeping the A/B/C, 1/2/3 labels
            // visible (see tintHeaderCell). Column cells fill from y=0; row cells
            // fill from x=0 — matching Fortune-sheet's own default header rects.
            afterRenderColumnHeaderCell: (
                _char: string,
                _idx: number,
                left: number,
                width: number,
                height: number,
                ctx: CanvasRenderingContext2D,
            ) => tintHeaderCell(left, 0, width, height, ctx),
            afterRenderRowHeaderCell: (
                _num: string,
                _idx: number,
                top: number,
                width: number,
                height: number,
                ctx: CanvasRenderingContext2D,
            ) => tintHeaderCell(0, top, width, height, ctx),
        }),
        [afterRenderCell],
    );

    // Fortune-sheet paints its grid on canvas, so CSS variable changes need an
    // explicit repaint when the root dark-mode class changes.
    useEffect(() => {
        const repaint = () => window.dispatchEvent(new Event("resize"));
        const observer = new MutationObserver(repaint);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class"],
        });
        return () => observer.disconnect();
    }, []);

    // Activate the cited sheet, bring the cell into view, and repaint the
    // highlight. We only scroll when the cell is off screen (centering it);
    // when it's already visible we leave the viewport put and force a redraw so
    // the `afterRenderCell` hook repaints the new highlight (and clears the old
    // one). Both paths must trigger a redraw: `scroll()` repaints because the
    // position changes, and the synthetic "resize" repaints in place via
    // Fortune-sheet's window resize handler.
    useEffect(() => {
        if (!active || !sheets) return;
        const target = highlightCells?.[0];

        const sheetIndex = target?.sheet
            ? Math.max(
                  0,
                  sheets.findIndex((s) => s.name === target.sheet),
              )
            : 0;

        const parsed = target?.cell ? parseRange(target.cell) : null;
        const range = parsed
            ? expandRangeForMerges(sheets[sheetIndex], parsed)
            : null;
        highlightRef.current = range;
        if (!range && !target?.sheet) return;

        const timer = window.setTimeout(() => {
            const inst = workbookRef.current;
            if (!inst) return;
            try {
                inst.activateSheet({ index: sheetIndex });
                if (!range) return;

                const container = containerRef.current;
                const sbX = container?.querySelector<HTMLElement>(
                    ".luckysheet-scrollbar-x",
                );
                const sbY = container?.querySelector<HTMLElement>(
                    ".luckysheet-scrollbar-y",
                );

                // Without the scrollbars we can't measure the viewport; fall back to
                // corner-scrolling, which at least brings the cell in and repaints.
                if (!sbX || !sbY) {
                    inst.scroll({
                        targetRow: range.row[0],
                        targetColumn: range.column[0],
                    });
                    return;
                }

                const rect = rangePixelRect(sheets[sheetIndex], range);
                const curLeft = sbX.scrollLeft;
                const curTop = sbY.scrollTop;
                const viewW = sbX.clientWidth;
                const viewH = sbY.clientHeight;
                const visible =
                    rect.x >= curLeft &&
                    rect.x + rect.w <= curLeft + viewW &&
                    rect.y >= curTop &&
                    rect.y + rect.h <= curTop + viewH;

                if (visible) {
                    // On screen: keep the viewport still, just repaint the highlight.
                    window.dispatchEvent(new Event("resize"));
                } else {
                    // Off screen: center the cell. scroll() re-renders and repaints.
                    inst.scroll({
                        scrollLeft: Math.max(
                            0,
                            Math.round(rect.x - (viewW - rect.w) / 2),
                        ),
                        scrollTop: Math.max(
                            0,
                            Math.round(rect.y - (viewH - rect.h) / 2),
                        ),
                    });
                }
            } catch {
                /* highlighting is best-effort */
            }
        }, 200);
        return () => window.clearTimeout(timer);
    }, [active, sheets, highlightCells, highlightKey]);

    const frameClass = `fortune-sheet-viewer relative flex flex-col flex-1 min-h-0 overflow-hidden ${rounded ? "rounded-lg" : ""}`;

    const message =
        error ?? (fetchError ? "Failed to load spreadsheet." : null);
    if (message) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500">
                    {message}
                </div>
            </div>
        );
    }

    if (!sheets || !WorkbookComponent) {
        return (
            <div className={frameClass}>
                <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                </div>
            </div>
        );
    }

    return (
        <div ref={containerRef} className={frameClass}>
            <div className="relative min-h-0 flex-1 flex flex-col">
                {active && (
                    <SpreadsheetWorkbook
                        key={workbookGeneration}
                        Workbook={WorkbookComponent}
                        workbookRef={workbookRef}
                        initialSession={session}
                        onSessionSave={setSession}
                        sheets={sheets}
                        hooks={hooks}
                    />
                )}
                <style jsx global>{`
                    /* The row/col header strips are transparent overlays over
                       the label canvas — leave them so the labels show. Only the
                       corner (no label) gets a matching gray background here; the
                       header strips are tinted on the canvas via render hooks. */
                    .fortune-sheet-viewer .fortune-left-top {
                        background-color: var(--spreadsheet-header-corner);
                    }

                    .fortune-sheet-viewer .fortune-row-header-hover,
                    .fortune-sheet-viewer .fortune-col-header-hover {
                        background-color: var(--spreadsheet-header-hover);
                    }

                    .fortune-sheet-viewer .fortune-row-header-selected,
                    .fortune-sheet-viewer .fortune-col-header-selected {
                        background-color: var(--spreadsheet-header-selected);
                    }
                `}</style>
            </div>
        </div>
    );
}

export default SpreadsheetView;

"use client";

import {
    useLayoutEffect,
    useState,
    useRef,
    useMemo,
    type RefObject,
} from "react";
import type { Sheet, Hooks } from "@fortune-sheet/core";
import type { WorkbookInstance } from "@fortune-sheet/react";

type WorkbookComponent = typeof import("@fortune-sheet/react").Workbook;
export type SpreadsheetSession = {
    sourceSheets: Sheet[];
    sheets: Sheet[];
    scrollLeft: number;
    scrollTop: number;
};

interface Props {
    Workbook: WorkbookComponent;
    sheets: Sheet[];
    hooks: Hooks;
    workbookRef: RefObject<WorkbookInstance | null>;
    initialSession: SpreadsheetSession | null;
    onSessionSave: (session: SpreadsheetSession) => void;
}

/** Mount only the active workbook: Fortune-sheet registers document-wide input handlers. */
export function SpreadsheetWorkbook({
    Workbook,
    sheets,
    hooks,
    workbookRef,
    initialSession,
    onSessionSave,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [saved] = useState(() =>
        initialSession?.sourceSheets === sheets ? initialSession : null,
    );
    // Fortune-sheet recalculates header dimensions when data changes, including zoomRatio.
    const [workbookSheets, setWorkbookSheets] = useState(
        saved?.sheets ?? sheets,
    );
    const currentSheetRef = useRef(
        workbookSheets.find((sheet) => sheet.status === 1)?.id ??
            workbookSheets[0]?.id,
    );
    const workbookHooks = useMemo<Hooks>(
        () => ({
            ...hooks,
            afterSelectionChange: (sheetId, selection) => {
                currentSheetRef.current = sheetId;
                hooks.afterSelectionChange?.(sheetId, selection);
            },
        }),
        [hooks],
    );

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const updateScrollExtent = () => {
            const rowExtent = container.querySelector<HTMLElement>(
                ".fortune-row-header > .luckysheetsheetchange",
            );
            const columnExtent = container.querySelector<HTMLElement>(
                ".fortune-col-header > .luckysheetsheetchange",
            );
            const overlay = container.querySelector<HTMLElement>(
                ".fortune-sheet-overlay",
            );
            const cells =
                container.querySelector<HTMLElement>(".fortune-cell-area");
            const spacer = container.querySelector<HTMLElement>(
                ".luckysheet-scrollbar-y > div",
            );
            const horizontalSpacer = container.querySelector<HTMLElement>(
                ".luckysheet-scrollbar-x > div",
            );
            if (
                !rowExtent ||
                !columnExtent ||
                !overlay ||
                !cells ||
                !spacer ||
                !horizontalSpacer
            )
                return;
            const headerHeight =
                Number.parseFloat(overlay.style.height) -
                Number.parseFloat(cells.style.height);
            const rowsHeight = Number.parseFloat(rowExtent.style.height) - 80;
            const columnsWidth =
                Number.parseFloat(columnExtent.style.width) - 120;
            if (
                !Number.isFinite(headerHeight) ||
                !Number.isFinite(rowsHeight) ||
                !Number.isFinite(columnsWidth)
            )
                return;
            // Fortune-sheet adds 80px below the rows and 120px after the columns.
            // Only the vertical viewport includes its header; thumbs overlay the grid.
            const height = `${Math.max(0, rowsHeight + headerHeight)}px`;
            const width = `${Math.max(0, columnsWidth)}px`;
            if (spacer.style.height !== height) spacer.style.height = height;
            if (horizontalSpacer.style.width !== width)
                horizontalSpacer.style.width = width;
        };
        // Sheet initialization, zoom, and resize update Fortune-sheet's inline geometry.
        const observer = new MutationObserver((records) => {
            if (
                records.some(
                    (record) =>
                        record.type === "childList" ||
                        (record.target instanceof HTMLElement &&
                            record.target.matches(
                                ".luckysheetsheetchange, .fortune-sheet-overlay, .fortune-cell-area, .luckysheet-scrollbar-y > div, .luckysheet-scrollbar-x > div",
                            )),
                )
            )
                updateScrollExtent();
        });
        observer.observe(container, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["style"],
        });
        updateScrollExtent();
        return () => observer.disconnect();
    }, []);

    useLayoutEffect(() => {
        let frame = 0;
        if (saved) {
            frame = requestAnimationFrame(() => {
                // Let Fortune-sheet finish initializing before restoring the viewport.
                frame = requestAnimationFrame(() => {
                    const workbook = workbookRef.current;
                    if (!workbook) return;
                    workbook.scroll({
                        scrollLeft: saved.scrollLeft,
                        scrollTop: saved.scrollTop,
                    });
                });
            });
        }
        return () => {
            cancelAnimationFrame(frame);
            const workbook = workbookRef.current;
            const container = containerRef.current;
            if (!workbook || !container) return;
            onSessionSave({
                sourceSheets: sheets,
                // status chooses the initial sheet; zoomRatio is already part of the sheet data.
                sheets: workbook.getAllSheets().map((sheet) => ({
                    ...sheet,
                    status: sheet.id === currentSheetRef.current ? 1 : 0,
                })),
                scrollLeft:
                    container.querySelector<HTMLElement>(
                        ".luckysheet-scrollbar-x",
                    )?.scrollLeft ?? 0,
                scrollTop:
                    container.querySelector<HTMLElement>(
                        ".luckysheet-scrollbar-y",
                    )?.scrollTop ?? 0,
            });
        };
    }, [saved, sheets, workbookRef, onSessionSave]);

    return (
        <div ref={containerRef} className="relative min-h-0 flex-1">
            <Workbook
                ref={workbookRef}
                data={workbookSheets}
                onChange={setWorkbookSheets}
                hooks={workbookHooks}
                allowEdit={false}
                showToolbar={false}
                showFormulaBar={false}
            />
        </div>
    );
}

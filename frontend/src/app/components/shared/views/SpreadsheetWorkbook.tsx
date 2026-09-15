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
    sessionRef: RefObject<SpreadsheetSession | null>;
}

/** Mount only the active workbook: Fortune-sheet registers document-wide input handlers. */
export function SpreadsheetWorkbook({
    Workbook,
    sheets,
    hooks,
    workbookRef,
    sessionRef,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [saved] = useState(() =>
        sessionRef.current?.sourceSheets === sheets ? sessionRef.current : null,
    );
    // Fortune-sheet recalculates header dimensions when data changes, including zoomRatio.
    const [workbookSheets, setWorkbookSheets] = useState(saved?.sheets ?? sheets);
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
            sessionRef.current = {
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
            };
        };
    }, [saved, sheets, workbookRef, sessionRef]);

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

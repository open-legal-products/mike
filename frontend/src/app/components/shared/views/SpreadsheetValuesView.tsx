"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SpreadsheetValuesPreview, SpreadsheetValueRange } from "@mike/contracts";
import { getSpreadsheetValuesPreview, getSpreadsheetValuesSource } from "@/app/lib/mikeApi";
import { downloadBlob } from "@/app/lib/downloadDocument";
import { notifyError, UserVisibleError, type UserFacingError } from "@/app/lib/userFacingError";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI, Dropdown, DropdownContent, DropdownRadioGroup, DropdownRadioItem, DropdownTrigger } from "@mike/ui";

export type ValuesHighlight = { sheet?: string; row: [number, number]; column: [number, number] };
type Props = {
    documentId: string;
    versionId?: string | null;
    refetchKey?: number | string;
    highlights?: ValuesHighlight[];
};
type Sheet = SpreadsheetValuesPreview["values"]["sheets"][number];
const PAGE_ROWS = 20;
const ERROR_MESSAGES = {
    spreadsheet_values_unsupported: "This workbook format cannot be shown as a values preview. The original source has not been converted.",
    spreadsheet_values_encrypted: "Encrypted workbooks cannot be previewed. Open the original in an application that supports its password protection.",
    spreadsheet_values_malformed: "This workbook could not be read safely. No partial values preview was produced.",
    spreadsheet_values_limit: "This workbook exceeds the values preview limits. No rows or cells have been silently omitted.",
    spreadsheet_values_unavailable: "Values preview is temporarily unavailable. Try again shortly.",
    spreadsheet_values_busy: "The values preview service is busy. Try again shortly.",
    spreadsheet_values_changed: "The source changed after this preview was prepared. Refresh the preview before downloading its source.",
};

function columnName(index: number): string {
    let name = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
}
function address(row: number, column: number) { return `${columnName(column)}${row + 1}`; }

// A contract failure must not turn an unexpected range into an unbounded DOM,
// or attach another source's identity to the displayed values.
function checkPreview(preview: SpreadsheetValuesPreview, documentId: string, versionId?: string | null) {
    const invalid = () => { throw new UserVisibleError("The values preview response was invalid. Refresh and try again.", { kind: "server", retryable: true }); };
    const encoder = new TextEncoder();
    const text = (value: unknown, max: number): value is string => typeof value === "string" && encoder.encode(value).length <= max;
    const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
    const validRange = (value: unknown): value is SpreadsheetValueRange => {
        if (!value || typeof value !== "object") return false;
        const r = value as SpreadsheetValueRange;
        return integer(r.startRow, 65535) && integer(r.endRow, 65535) && integer(r.startColumn, 255) && integer(r.endColumn, 255)
            && r.endRow >= r.startRow && r.endColumn >= r.startColumn
            && r.endRow - r.startRow < 200 && r.endColumn - r.startColumn < 50;
    };
    const source = preview?.source;
    const values = preview?.values;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (!source || source.documentId !== documentId || !uuid.test(source.versionId) || (versionId && source.versionId !== versionId)
        || !/^[a-f0-9]{64}$/i.test(source.sha256) || !text(source.filename, 4096)
        || !integer(source.bytes, 5 * 1024 * 1024) || source.bytes === 0
        || !values || !text(values.parserVersion, 64) || !Array.isArray(values.warnings) || values.warnings.length > 32
        || !values.warnings.every(warning => text(warning, 4096)) || !Array.isArray(values.sheets)
        || !values.sheets.length || values.sheets.length > 8 || encoder.encode(JSON.stringify(values)).length > 1024 * 1024) invalid();
    let positions = 0, stored = 0;
    const sheetNames = new Set<string>();
    for (const sheet of values.sheets) {
        if (!sheet || !text(sheet.name, 512) || !["visible", "hidden", "very-hidden"].includes(sheet.visibility)
            || !Array.isArray(sheet.cells) || !Array.isArray(sheet.merges) || !Array.isArray(sheet.hiddenRows) || !Array.isArray(sheet.hiddenColumns)
            || sheet.cells.length > 5_000 || sheet.merges.length > 5_000 || sheet.hiddenRows.length > 200 || sheet.hiddenColumns.length > 50
            || (sheet.range !== null && !validRange(sheet.range))) invalid();
        const name = sheet.name.toLowerCase();
        if (sheetNames.has(name)) invalid();
        sheetNames.add(name);
        const range = sheet.range;
        if (!range) {
            if (sheet.cells.length || sheet.merges.length || sheet.hiddenRows.length || sheet.hiddenColumns.length) invalid();
            continue;
        }
        positions += (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1);
        stored += sheet.cells.length;
        if (positions > 5_000 || stored > 5_000
            || !sheet.hiddenRows.every(row => integer(row, 65535) && row >= range.startRow && row <= range.endRow)
            || !sheet.hiddenColumns.every(column => integer(column, 255) && column >= range.startColumn && column <= range.endColumn)
            || !sheet.merges.every(merge => validRange(merge) && merge.startRow >= range.startRow && merge.endRow <= range.endRow
                && merge.startColumn >= range.startColumn && merge.endColumn <= range.endColumn)) invalid();
        const seen = new Set<string>();
        for (const cell of sheet.cells) {
            if (!cell || !integer(cell.row, 65535) || !integer(cell.column, 255) || cell.row < range.startRow || cell.row > range.endRow
                || cell.column < range.startColumn || cell.column > range.endColumn || cell.address !== address(cell.row, cell.column)
                || seen.has(cell.address) || !text(cell.displayText, 512) || !["number", "text", "boolean", "error", "blank", "formula"].includes(cell.kind)
                || !["none", "cached", "missing"].includes(cell.formulaStatus)
                || (cell.kind === "formula") !== (cell.formulaStatus !== "none")) invalid();
            seen.add(cell.address);
        }
    }
}

export function SpreadsheetValuesView(props: Props) {
    const [attempt, setAttempt] = useState(0);
    const key = JSON.stringify([props.documentId, props.versionId ?? null, props.refetchKey ?? null, attempt]);
    return <ValuesSource key={key} {...props} retry={() => setAttempt(value => value + 1)} />;
}

function ValuesSource({ documentId, versionId, highlights = [], retry }: Props & { retry: () => void }) {
    const [preview, setPreview] = useState<SpreadsheetValuesPreview | null>(null);
    const [failure, setFailure] = useState<UserFacingError | null>(null);
    const [downloading, setDownloading] = useState(false);
    const downloadRequest = useRef<AbortController | null>(null);
    useEffect(() => {
        const request = new AbortController();
        let current = true;
        getSpreadsheetValuesPreview(documentId, versionId, request.signal).then(result => {
            if (!current) return;
            checkPreview(result, documentId, versionId);
            setPreview(result);
        }).catch(error => {
            if (!current || request.signal.aborted) return;
            setFailure(notifyError(error, { action: "preview the stored spreadsheet values", codeMessages: ERROR_MESSAGES }));
        });
        return () => { current = false; request.abort(); downloadRequest.current?.abort(); };
    }, [documentId, versionId]);

    async function download() {
        if (!preview || downloadRequest.current) return;
        const request = new AbortController();
        downloadRequest.current = request;
        setDownloading(true);
        try {
            const file = await getSpreadsheetValuesSource(preview.source, request.signal);
            if (!request.signal.aborted) downloadBlob(file.blob, file.filename || preview.source.filename);
        } catch (error) {
            if (request.signal.aborted) return;
            const described = notifyError(error, { action: "download the previewed spreadsheet source", codeMessages: ERROR_MESSAGES });
            if (described && ["conflict", "forbidden", "unauthenticated", "not_found"].includes(described.kind)) {
                setPreview(null);
                setFailure(described);
            }
        } finally {
            downloadRequest.current = null;
            if (!request.signal.aborted) setDownloading(false);
        }
    }

    if (failure) return <div role="alert" className="p-6"><EmptyState tone="error" title={failure.title} description={failure.message}
        action={failure.retryable ? <PillButtonUI tone="white" onClick={retry}>Refresh preview</PillButtonUI> : undefined} /></div>;
    if (!preview) return <div role="status" className="p-6 text-sm text-gray-500">Loading stored spreadsheet values…</div>;
    return <div className="h-full overflow-auto p-4 text-sm text-gray-800 space-y-4">
        <div className="space-y-2">
            <h2 className="font-serif text-lg">Read-only spreadsheet values</h2>
            <p>Stored values only. Formulas are not evaluated; stored results may be stale. Formatting, charts, images and layout are not reproduced. No editing, macros, external refresh or active cell links.</p>
            <p className="break-all">{preview.source.filename} · {preview.source.bytes.toLocaleString()} original bytes</p>
            <details><summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-blue-500">Source revision and preview limits</summary>
                <dl className="mt-2 space-y-1 text-xs break-all"><dt>Document</dt><dd>{preview.source.documentId}</dd><dt>Version</dt><dd>{preview.source.versionId}</dd><dt>SHA-256</dt><dd>{preview.source.sha256}</dd><dt>Parser</dt><dd>SheetJS {preview.values.parserVersion}</dd></dl>
                <p className="mt-2 text-xs">At most 5 MiB, 8 sheets, 200 rows and 50 columns per used range, 5,000 total range positions and 5,000 stored cells. Exceeding a limit fails the preview rather than truncating it.</p>
            </details>
            <PillButtonUI tone="white" loading={downloading} onClick={() => void download()}>Download previewed original</PillButtonUI>
            {preview.values.warnings.length > 0 && <ul className="list-disc pl-5">{preview.values.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        </div>
        <ValuesTable preview={preview} highlights={highlights} />
    </div>;
}

function firstTarget(sheets: Sheet[], highlights: ValuesHighlight[]) {
    for (const target of highlights) {
        const index = target.sheet ? sheets.findIndex(sheet => sheet.name === target.sheet) : 0;
        const range = sheets[index]?.range;
        if (range && target.row[1] >= range.startRow && target.row[0] <= range.endRow
            && target.column[1] >= range.startColumn && target.column[0] <= range.endColumn) {
            return { sheet: index, page: Math.floor((Math.max(target.row[0], range.startRow) - range.startRow) / PAGE_ROWS) };
        }
    }
    return { sheet: 0, page: 0 };
}

function ValuesTable({ preview, highlights }: { preview: SpreadsheetValuesPreview; highlights: ValuesHighlight[] }) {
    const sheets = preview.values.sheets;
    const highlightKey = JSON.stringify(highlights);
    const navigationKey = JSON.stringify([preview.source.versionId, preview.source.sha256, highlights]);
    const [navigation, setNavigation] = useState(() => ({ key: navigationKey, ...firstTarget(sheets, highlights) }));
    // A changed citation gets its own initial position without an effect that
    // briefly paints the previous sheet or triggers a second state render.
    const position = navigation.key === navigationKey ? navigation : { key: navigationKey, ...firstTarget(sheets, highlights) };
    const grid = useRef<HTMLTableElement>(null);
    function changePage(delta: number) {
        setNavigation(value => {
            const current = value.key === navigationKey ? value : { key: navigationKey, ...firstTarget(sheets, highlights) };
            const range = sheets[current.sheet].range;
            const last = range ? Math.floor((range.endRow - range.startRow) / PAGE_ROWS) : 0;
            return { ...current, page: Math.max(0, Math.min(last, current.page + delta)) };
        });
    }
    const sheet = sheets[position.sheet];
    const range = sheet.range;
    const cells = useMemo(() => new Map(sheet.cells.map(cell => [`${cell.row}:${cell.column}`, cell])), [sheet]);
    const start = range ? range.startRow + position.page * PAGE_ROWS : 0;
    const end = range ? Math.min(range.endRow, start + PAGE_ROWS - 1) : -1;
    useEffect(() => { grid.current?.querySelector<HTMLElement>("[data-citation-highlight]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [highlightKey, position.sheet, position.page]);
    const highlighted = (row: number, column: number) => highlights.some(target => (!target.sheet || target.sheet === sheet.name)
        && row >= target.row[0] && row <= target.row[1] && column >= target.column[0] && column <= target.column[1]);
    return <section aria-label="Stored values">
        <Dropdown><DropdownTrigger asChild><PillButtonUI tone="white" className="h-auto max-w-full whitespace-normal break-all py-2 text-left leading-normal" aria-label={`Choose sheet: ${sheet.name}`}>Sheet: {sheet.name}</PillButtonUI></DropdownTrigger>
            <DropdownContent className="max-w-[calc(100vw-2rem)]"><DropdownRadioGroup value={String(position.sheet)} onValueChange={value => { const index = Number(value); if (Number.isInteger(index) && index >= 0 && index < sheets.length) setNavigation({ key: navigationKey, sheet: index, page: 0 }); }}>
                {sheets.map((item, index) => <DropdownRadioItem key={index} value={String(index)} className="whitespace-normal break-all">{item.name} ({item.visibility})</DropdownRadioItem>)}
            </DropdownRadioGroup></DropdownContent>
        </Dropdown>
        <p className="mt-2">{sheet.visibility} in the original. Hidden rows and columns are labelled and remain visible here.</p>
        <p className="break-words">Merged ranges: {sheet.merges.map(merge => `${address(merge.startRow, merge.startColumn)}:${address(merge.endRow, merge.endColumn)}`).join(", ") || "none"}. Cells keep their source coordinates; this table does not reproduce merged layout.</p>
        {!range ? <p role="status" className="mt-3">Empty sheet — no used cell range.</p> : <>
            <div className="my-3 flex flex-wrap items-center gap-2">
                <PillButtonUI tone="white" disabled={position.page === 0} onClick={() => changePage(-1)}>Previous rows</PillButtonUI>
                <p role="status">Rows {start + 1}–{end + 1} of source range {address(range.startRow, range.startColumn)}:{address(range.endRow, range.endColumn)}</p>
                <PillButtonUI tone="white" disabled={end === range.endRow} onClick={() => changePage(1)}>Next rows</PillButtonUI>
            </div>
            <div role="region" aria-label="Scrollable stored cell values" tabIndex={0} className="max-h-[32rem] overflow-auto rounded focus-visible:outline-2 focus-visible:outline-blue-500">
                <table ref={grid} aria-label={`${sheet.name} stored values`} className="min-w-full text-xs">
                    <caption className="sr-only">Read-only stored cell values, not recalculated or full-fidelity Excel rendering.</caption>
                    <thead className="sticky top-0 bg-app-surface"><tr><th scope="col" className="p-2 text-left">Source row</th>{Array.from({ length: range.endColumn - range.startColumn + 1 }, (_, index) => {
                        const column = range.startColumn + index;
                        return <th scope="col" className="p-2 text-left" key={column}>{columnName(column)}{sheet.hiddenColumns.includes(column) ? " (hidden)" : ""}</th>;
                    })}</tr></thead>
                    <tbody>{Array.from({ length: end - start + 1 }, (_, index) => {
                        const row = start + index;
                        return <tr key={row}><th scope="row" className="p-2 text-left align-top">{row + 1}{sheet.hiddenRows.includes(row) ? " (hidden)" : ""}</th>{Array.from({ length: range.endColumn - range.startColumn + 1 }, (_, index) => {
                            const column = range.startColumn + index;
                            const cell = cells.get(`${row}:${column}`);
                            const mark = highlighted(row, column);
                            return <td key={column} data-address={address(row, column)} data-citation-highlight={mark || undefined}
                                style={mark ? { backgroundColor: "var(--spreadsheet-highlight-background)", outline: "1px solid var(--spreadsheet-highlight-outline)" } : undefined}
                                className="min-w-32 max-w-96 whitespace-pre-wrap break-words p-2 align-top">
                                <span>{cell?.displayText ?? ""}</span>
                                {cell?.formulaStatus === "cached" && <span className="mt-1 block text-gray-500">Stored formula result{cell.displayText === "" ? " (blank)" : ""} — not recalculated; may be stale.</span>}
                                {cell?.formulaStatus === "missing" && <span className="mt-1 block text-gray-500">Formula has no usable stored result.</span>}
                            </td>;
                        })}</tr>;
                    })}</tbody>
                </table>
            </div>
        </>}
    </section>;
}

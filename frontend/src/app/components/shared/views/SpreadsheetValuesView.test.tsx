import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { SpreadsheetValuesPreview } from "@mike/contracts";
import { SpreadsheetValuesView } from "./SpreadsheetValuesView";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), source: vi.fn(), save: vi.fn(), notify: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ getSpreadsheetValuesPreview: mocks.preview, getSpreadsheetValuesSource: mocks.source }));
vi.mock("@/app/lib/downloadDocument", () => ({ downloadBlob: mocks.save }));
vi.mock("@/app/lib/userFacingError", async () => {
    const actual = await import("@/shared/lib/userError");
    return { ...actual, notifyError: (...args: Parameters<typeof actual.describeError>) => { mocks.notify(...args); return actual.describeError(...args); } };
});
const DOC = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";
const cell = (row: number, column: number, displayText: string, formulaStatus: "none" | "cached" | "missing" = "none") => ({
    row, column, address: `${String.fromCharCode(65 + column)}${row + 1}`, displayText,
    kind: formulaStatus === "none" ? "text" as const : "formula" as const, formulaStatus,
});
function fixture(): SpreadsheetValuesPreview {
    return {
        source: { documentId: DOC, versionId: VERSION, sha256: "a".repeat(64), filename: "Synthetic.xls", bytes: 3584 },
        values: { parserVersion: "0.20.3", warnings: ["Fictional fixture — stored values only."], sheets: [
            { name: "Values", visibility: "visible", range: { startRow: 5, endRow: 46, startColumn: 1, endColumn: 2 },
                merges: [{ startRow: 5, endRow: 5, startColumn: 1, endColumn: 2 }], hiddenRows: [6], hiddenColumns: [2], cells: [
                    cell(5, 1, "<img src=x onerror=alert(1)>"), cell(5, 2, "=1+2"), cell(6, 1, "999", "cached"),
                    cell(7, 1, "", "cached"), cell(8, 1, "", "missing"), cell(45, 1, "Referenced value"),
                ] },
            { name: "Hidden", visibility: "very-hidden", range: null, merges: [], hiddenRows: [], hiddenColumns: [], cells: [] },
        ] },
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.preview.mockResolvedValue(fixture());
    mocks.source.mockResolvedValue({ blob: new Blob(["original bytes"]), filename: "Original.xls" });
});

it("escapes values, preserves literal formulas and distinguishes cached blank from missing values", async () => {
    render(<SpreadsheetValuesView documentId={DOC} />);
    const table = await screen.findByRole("table", { name: "Values stored values" });
    expect(within(table).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(within(table).getByText("=1+2")).toBeInTheDocument();
    expect(within(table).getByText("999")).toBeInTheDocument();
    expect(within(table).getByText(/Stored formula result \(blank\)/)).toBeInTheDocument();
    expect(within(table).getByText(/Formula has no usable stored result/)).toBeInTheDocument();
    expect(document.querySelectorAll("table img, table script, table a, table input, table textarea, [contenteditable]")).toHaveLength(0);
    expect(screen.getByText(/Formulas are not evaluated/)).toBeInTheDocument();
    expect(screen.getByText(/B6:C6/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "C (hidden)" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "7 (hidden)" })).toBeInTheDocument();
});

it("shows hidden and empty sheets honestly through the existing keyboard-accessible sheet menu", async () => {
    const user = userEvent.setup();
    render(<SpreadsheetValuesView documentId={DOC} />);
    await user.click(await screen.findByRole("button", { name: "Choose sheet: Values" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Hidden (very-hidden)" }));
    expect(screen.getByText(/very-hidden in the original/)).toBeInTheDocument();
    expect(screen.getByText(/Empty sheet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
});

it("keeps exact source coordinates across pages and navigates a citation to its containing page", async () => {
    const { rerender } = render(<SpreadsheetValuesView documentId={DOC} />);
    await screen.findByRole("table");
    expect(screen.getByText(/Rows 6–25/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next rows" }));
    expect(screen.getByText(/Rows 26–45/)).toBeInTheDocument();
    rerender(<SpreadsheetValuesView documentId={DOC} highlights={[{ sheet: "Values", row: [45, 45], column: [1, 1] }]} />);
    await waitFor(() => expect(screen.getByText(/Rows 46–47/)).toBeInTheDocument());
    expect(screen.getByText("Referenced value").closest("td")).toHaveAttribute("data-address", "B46");
    expect(screen.getByText("Referenced value").closest("td")).toHaveAttribute("data-citation-highlight");
    expect(screen.getByRole("button", { name: "Next rows" })).toBeDisabled();
    expect(mocks.preview).toHaveBeenCalledTimes(1);
});

it("clamps rapid repeated paging to the actual source range", async () => {
    render(<SpreadsheetValuesView documentId={DOC} />);
    await screen.findByRole("table");
    const next = screen.getByRole("button", { name: "Next rows" });
    act(() => { for (let i = 0; i < 5; i++) fireEvent.click(next); });
    expect(screen.getByText(/Rows 46–47/)).toBeInTheDocument();
    expect(next).toBeDisabled();
});

it("clears old output immediately and ignores late responses after document, version or refetch changes", async () => {
    const first = deferred<SpreadsheetValuesPreview>();
    const second = deferred<SpreadsheetValuesPreview>();
    mocks.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<SpreadsheetValuesView documentId={DOC} />);
    const signal = mocks.preview.mock.calls[0][2] as AbortSignal;
    rerender(<SpreadsheetValuesView documentId={SECOND} versionId={VERSION} refetchKey={1} />);
    expect(signal.aborted).toBe(true);
    const current = fixture(); current.source.documentId = SECOND; current.source.filename = "Second.xls";
    await act(async () => { second.resolve(current); });
    expect(screen.getByText(/Second.xls/)).toBeInTheDocument();
    await act(async () => { first.resolve(fixture()); });
    expect(screen.queryByText(/Synthetic.xls/)).toBeNull();
    const third = deferred<SpreadsheetValuesPreview>(); mocks.preview.mockReturnValueOnce(third.promise);
    rerender(<SpreadsheetValuesView documentId={SECOND} versionId={VERSION} refetchKey={2} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Loading stored/);
});

it("aborts unmounted requests and suppresses an ignored-abort response and notification", async () => {
    const pending = deferred<SpreadsheetValuesPreview>(); mocks.preview.mockReturnValue(pending.promise);
    const { unmount } = render(<SpreadsheetValuesView documentId={DOC} />);
    const signal = mocks.preview.mock.calls[0][2] as AbortSignal;
    unmount();
    await act(async () => { pending.resolve(fixture()); });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
});

it("refuses a different valid source version beneath a pinned version label", async () => {
    render(<SpreadsheetValuesView documentId={DOC} versionId={SECOND} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/response was invalid/);
    expect(screen.queryByRole("table")).toBeNull();
});

it("downloads the exact returned checkpoint through the authenticated helper and existing Blob save utility", async () => {
    render(<SpreadsheetValuesView documentId={DOC} />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Download previewed original" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.source).toHaveBeenCalledWith(fixture().source, expect.any(AbortSignal));
    expect(mocks.save).toHaveBeenCalledWith(expect.any(Blob), "Original.xls");
});

it("does not save a late download belonging to a viewer that navigated away", async () => {
    const pending = deferred<{ blob: Blob; filename: string }>(); mocks.source.mockReturnValue(pending.promise);
    const { rerender } = render(<SpreadsheetValuesView documentId={DOC} />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Download previewed original" }));
    const signal = mocks.source.mock.calls[0][1] as AbortSignal;
    const next = fixture(); next.source.documentId = SECOND; mocks.preview.mockResolvedValue(next);
    rerender(<SpreadsheetValuesView documentId={SECOND} />);
    await act(async () => { pending.resolve({ blob: new Blob(["old"]), filename: "Old.xls" }); });
    expect(signal.aborted).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
});

it("clears values on a changed-source download and obtains a new checkpoint only after refresh", async () => {
    const user = userEvent.setup();
    mocks.source.mockRejectedValue({ status: 409, code: "spreadsheet_values_changed", message: "private upstream detail" });
    render(<SpreadsheetValuesView documentId={DOC} />);
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Download previewed original" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/private upstream detail/)).toBeNull();
    const changed = fixture(); changed.source.sha256 = "b".repeat(64); mocks.preview.mockResolvedValue(changed);
    await user.click(screen.getByRole("button", { name: "Refresh preview" }));
    await screen.findByRole("table");
    expect(mocks.preview).toHaveBeenCalledTimes(2);
});

it("reports busy service safely and recovers through a fresh request", async () => {
    mocks.preview.mockRejectedValueOnce({ status: 503, code: "spreadsheet_values_busy", message: "private process path" });
    render(<SpreadsheetValuesView documentId={DOC} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/service is busy/);
    expect(screen.queryByText(/private process path/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await screen.findByRole("table");
});

it.each(["unsupported", "encrypted", "malformed", "limit"])("shows explicit %s failure instead of partial or empty values", async suffix => {
    mocks.preview.mockRejectedValueOnce({ status: suffix === "limit" ? 413 : 400, code: `spreadsheet_values_${suffix}`, message: "private parser text" });
    render(<SpreadsheetValuesView documentId={DOC} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/private parser text/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh preview" })).toBeNull();
});

it.each([
    ["warnings", (p: SpreadsheetValuesPreview) => { p.values.warnings = null as never; }],
    ["merges", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].merges = null as never; }],
    ["hidden metadata", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].hiddenColumns = [999]; }],
    ["sheet name", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].name = {} as never; }],
    ["ambiguous sheet names", (p: SpreadsheetValuesPreview) => { p.values.sheets[1].name = "vAlUeS"; }],
    ["visibility", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].visibility = "unknown" as never; }],
    ["large range", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].range!.endColumn = 1e9; }],
    ["cell coordinates", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].cells[0].row = -1; }],
    ["address", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].cells[0].address = "A1"; }],
    ["duplicate cells", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].cells.push(p.values.sheets[0].cells[0]); }],
    ["display text", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].cells[0].displayText = "€".repeat(171); }],
    ["cell kind", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].cells[0].kind = "html" as never; }],
    ["formula status", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].cells[0].formulaStatus = "verified" as never; }],
    ["source binding", (p: SpreadsheetValuesPreview) => { p.source.documentId = SECOND; }],
    ["source version", (p: SpreadsheetValuesPreview) => { p.source.versionId = "not-a-version"; }],
    ["source size", (p: SpreadsheetValuesPreview) => { p.source.bytes = -1; }],
    ["aggregate ranges", (p: SpreadsheetValuesPreview) => { p.values.sheets[0].range = { startRow: 0, endRow: 199, startColumn: 0, endColumn: 49 }; }],
] as const)("rejects malformed %s without rendering a misleading table or throwing during render", async (_name, mutate) => {
    const value = fixture(); mutate(value); mocks.preview.mockResolvedValue(value);
    render(<SpreadsheetValuesView documentId={DOC} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/response was invalid/);
    expect(screen.queryByRole("table")).toBeNull();
});

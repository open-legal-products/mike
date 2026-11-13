import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpreadsheetView } from "./SpreadsheetView";

type Parsed = { sheets: { id: string; name: string; celldata: never[]; config: object }[] };
const state = vi.hoisted(() => ({
    fetch: vi.fn(),
    callbacks: [] as ((value: Parsed) => void)[],
}));

// Exercise the real byte-fetch hook, including its retained-byte behavior.
vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: state.fetch }));
vi.mock("@/app/lib/mikeApi", () => ({
    getDocumentFileUrl: (id: string, version?: string | null) => `/synthetic/${id}/${version ?? "active"}`,
}));
vi.mock("luckyexcel", () => ({
    default: { transformExcelToLucky: (_file: File, done: (value: Parsed) => void) => { state.callbacks.push(done); } },
}));
vi.mock("@fortune-sheet/react", () => ({ Workbook: () => null }));
vi.mock("./SpreadsheetWorkbook", () => ({
    SpreadsheetWorkbook: ({ sheets }: Parsed) => <div>Preview {sheets[0].name}</div>,
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const workbook = (name: string): Parsed => ({ sheets: [{ id: name, name, celldata: [], config: {} }] });
const response = (bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])) => new Response(bytes);

beforeEach(() => { state.fetch.mockReset(); state.callbacks.length = 0; });
afterEach(() => { vi.useRealTimers(); });

it.each([
    { versionId: "v2" },
    { refetchKey: 1 },
    { documentId: "second" },
    { displayUrl: "/synthetic/replacement.xlsx" },
])("rejects an old callback while new source %j is still fetching", async (change) => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    state.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const initial = { documentId: "first", versionId: "v1", refetchKey: 0 };
    const { rerender } = render(<SpreadsheetView {...initial} />);
    await act(async () => { first.resolve(response()); });
    expect(state.callbacks).toHaveLength(1);

    rerender(<SpreadsheetView {...initial} {...change} />);
    expect(state.fetch).toHaveBeenCalledTimes(2);
    await act(async () => { state.callbacks[0](workbook("old")); });
    expect(screen.queryByText("Preview old")).toBeNull();

    await act(async () => { second.resolve(response()); });
    expect(state.callbacks).toHaveLength(2);
    await act(async () => { state.callbacks[1](workbook("new")); });
    expect(screen.getByText("Preview new")).toBeInTheDocument();
    expect(screen.queryByText("Preview old")).toBeNull();
});

it("cancels the old deadline during replacement fetch and starts a fresh deadline for new bytes", async () => {
    vi.useFakeTimers();
    const first = deferred<Response>();
    const second = deferred<Response>();
    state.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<SpreadsheetView documentId="same" versionId="v1" />);
    await act(async () => { first.resolve(response()); });
    act(() => { vi.advanceTimersByTime(10_000); });

    rerender(<SpreadsheetView documentId="same" versionId="v2" />);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { second.resolve(response()); });
    act(() => { vi.advanceTimersByTime(29_999); });
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be displayed/);
});

it("clears an old OLE error while the next source fetches and reports its own failure", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    state.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<SpreadsheetView documentId="same" versionId="v1" />);
    await act(async () => { first.resolve(response(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))); });
    expect(screen.getByRole("alert")).toHaveTextContent(/Legacy or encrypted/);

    rerender(<SpreadsheetView documentId="same" versionId="v2" />);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { second.reject(new Error("synthetic fetch failure")); });
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load spreadsheet.");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Legacy or encrypted/);
});

it("retains same-source parsing across visibility and citation changes", async () => {
    state.fetch.mockResolvedValue(response());
    const { rerender } = render(<SpreadsheetView documentId="same" />);
    await act(async () => {});
    rerender(<SpreadsheetView documentId="same" active={false} highlightCells={[{ cell: "A1" }]} />);
    await act(async () => { state.callbacks[0](workbook("same")); });
    rerender(<SpreadsheetView documentId="same" active highlightCells={[{ cell: "B2" }]} />);

    expect(screen.getByText("Preview same")).toBeInTheDocument();
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.callbacks).toHaveLength(1);
});

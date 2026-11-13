import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkbookInstance } from "@fortune-sheet/react";
import type { Cell, Sheet } from "@fortune-sheet/core";
import { SpreadsheetView } from "./SpreadsheetView";

const state = vi.hoisted(() => ({
    bytes: null as ArrayBuffer | null,
    fetch: vi.fn(),
    parse: vi.fn(),
    mounts: vi.fn(),
}));
vi.mock("@/app/hooks/useFetchDocxBytes", () => ({
    useFetchDocxBytes: (...args: unknown[]) => {
        state.fetch(...args);
        return { bytes: state.bytes, loading: false, error: null };
    },
}));
vi.mock("luckyexcel", () => ({
    default: { transformExcelToLucky: state.parse },
}));
vi.mock("@fortune-sheet/react", () => ({
    Workbook: forwardRef<WorkbookInstance, { data: Sheet[] }>(function Workbook(
        { data },
        ref,
    ) {
        const [zoom, setZoom] = useState(data[0].zoomRatio ?? 1);
        // Like Fortune-sheet, read cells from celldata once into a data matrix.
        const [cells] = useState(() => {
            const matrix: (Cell | null)[][] = [];
            for (const { r, c, v } of data[0].celldata ?? []) {
                (matrix[r] ??= [])[c] = v;
            }
            return matrix;
        });
        const x = useRef<HTMLDivElement>(null);
        const y = useRef<HTMLDivElement>(null);
        useEffect(() => {
            state.mounts();
            const onKey = (event: KeyboardEvent) => {
                if (event.ctrlKey && event.key === "+") {
                    event.preventDefault();
                    setZoom((value) => value + 0.1);
                }
            };
            document.addEventListener("keydown", onKey);
            return () => document.removeEventListener("keydown", onKey);
        }, []);
        useImperativeHandle(
            ref,
            () =>
                ({
                    getSheet: () => data[0],
                    getAllSheets: () => {
                        const sheet = { ...data[0], data: cells, zoomRatio: zoom };
                        delete sheet.celldata;
                        return [sheet];
                    },
                    dataToCelldata: (matrix: (Cell | null)[][] | undefined) =>
                        (matrix ?? []).flatMap((row, r) =>
                            row.flatMap((v, c) => (v ? [{ r, c, v }] : [])),
                        ),
                    getSelection: () => [{ row: [2, 2], column: [3, 3] }],
                    setSelection: vi.fn(),
                    activateSheet: vi.fn(),
                    scroll: ({
                        scrollLeft,
                        scrollTop,
                    }: {
                        scrollLeft: number;
                        scrollTop: number;
                    }) => {
                        if (x.current) x.current.scrollLeft = scrollLeft;
                        if (y.current) y.current.scrollTop = scrollTop;
                    },
                }) as unknown as WorkbookInstance,
            [data, cells, zoom],
        );
        return (
            <div>
                <span>Zoom {zoom}</span>
                {cells.flatMap((row, r) =>
                    row.map((cell, c) => (
                        <span key={`${r}_${c}`}>{cell?.v}</span>
                    )),
                )}
                {data[0].images?.map((image) => (
                    <img
                        key={image.id}
                        src={image.src}
                        alt="Embedded spreadsheet image"
                        width={image.width}
                        height={image.height}
                        style={{ left: image.left, top: image.top }}
                    />
                ))}
                <div
                    ref={x}
                    data-testid="x"
                    className="luckysheet-scrollbar-x"
                />
                <div
                    ref={y}
                    data-testid="y"
                    className="luckysheet-scrollbar-y"
                />
            </div>
        );
    }),
}));

// An .xlsx starts with a ZIP local file header; the view rejects anything else.
const xlsxBytes = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]).buffer;

beforeEach(() => {
    vi.clearAllMocks();
    state.bytes = xlsxBytes();
    state.parse.mockImplementation((_file, done) =>
        done({
            sheets: [
                {
                    id: "s1",
                    name: "Budget",
                    celldata: [{ r: 0, c: 0, v: { v: "Total" } }],
                    config: {},
                    status: 1,
                },
            ],
        }),
    );
});
afterEach(() => vi.restoreAllMocks());

it("reports a legacy or encrypted OLE workbook without handing it to the XLSX-only parser", () => {
    state.bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]).buffer;
    render(<SpreadsheetView documentId="legacy-workbook" />);

    expect(screen.getByRole("alert")).toHaveTextContent(/Legacy or encrypted Excel files cannot be previewed/);
    expect(screen.getByRole("alert")).toHaveTextContent(/save an unencrypted .xlsx copy and upload it/);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/Download the original/);
    expect(state.parse).not.toHaveBeenCalled();
});

it.each([
    ["an HTML table saved as .xls", new TextEncoder().encode("<table><tr><td>1</td></tr></table>").buffer],
    ["an empty file", new ArrayBuffer(0)],
    ["an empty ZIP archive", new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0]).buffer],
])("reports %s at once instead of waiting out the parser deadline", (_name, bytes) => {
    state.bytes = bytes;
    render(<SpreadsheetView documentId="not-a-zip" />);

    expect(screen.getByRole("alert")).toHaveTextContent(/This spreadsheet could not be displayed/);
    expect(state.parse).not.toHaveBeenCalled();
});

it("leaves out download and upload advice when the host offers neither", () => {
    state.bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).buffer;
    const { rerender } = render(<SpreadsheetView documentId="legacy" fileActions={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/^Legacy or encrypted Excel files cannot be previewed here\.$/);

    state.bytes = new ArrayBuffer(0);
    rerender(<SpreadsheetView documentId="unreadable" fileActions={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/^This spreadsheet could not be displayed\.$/);
});

it("ends a silent parser failure and ignores a callback arriving after the preview timed out", async () => {
    vi.useFakeTimers();
    let finish: ((value: { sheets: Sheet[] }) => void) | undefined;
    state.parse.mockImplementation((_file, done) => { finish = done; });
    const { unmount } = render(<SpreadsheetView documentId="silent-parser" />);
    try {
        expect(screen.queryByRole("alert")).toBeNull();
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(screen.getByRole("alert")).toHaveTextContent(/could not be displayed/);

        await act(async () => { finish?.({ sheets: [{ id: "late", name: "Late", data: [] }] }); });
        expect(screen.queryByText("Zoom 1")).toBeNull();
        expect(screen.getByRole("alert")).toHaveTextContent(/could not be displayed/);
    } finally {
        unmount();
        vi.useRealTimers();
    }
});

it("clears the parser deadline after a successful callback", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<SpreadsheetView documentId="successful-parser" />);
    try {
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(screen.getByText("Zoom 1")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).toBeNull();
    } finally {
        unmount();
        vi.useRealTimers();
    }
});

it("reports malformed asynchronous parser output instead of throwing or waiting forever", async () => {
    let finish: ((value: unknown) => void) | undefined;
    state.parse.mockImplementation((_file, done) => { finish = done; });
    render(<SpreadsheetView documentId="invalid-parser-output" />);

    await act(async () => { finish?.({ sheets: [null] }); });

    expect(screen.getByRole("alert")).toHaveTextContent(/could not be displayed/);
    expect(screen.queryByText("Zoom 1")).toBeNull();
});

it("clears a pending parser deadline when the viewer unmounts", () => {
    vi.useFakeTimers();
    state.parse.mockImplementation(() => {});
    const { unmount } = render(<SpreadsheetView documentId="pending-parser" />);
    try {
        expect(vi.getTimerCount()).toBe(1);
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        unmount();
        vi.useRealTimers();
    }
});

it("loads the raw workbook from /file, uncached, rather than the PDF display route", async () => {
    render(<SpreadsheetView documentId="sheet" versionId="v2" refetchKey={3} />);
    await screen.findByText("Zoom 1");
    // No source URL means the hook reads /file for this document version.
    expect(state.fetch).toHaveBeenCalledWith("sheet", "v2", 3, undefined, false);
});

it("scrolls a cited cell into the available canvas without remounting the workbook", async () => {
    const highlights = [{ sheet: "Budget", cell: "B21" }];
    const view = (selected = false) => (
        <SpreadsheetView documentId="sheet" highlightCells={selected ? highlights : undefined} />
    );
    const { rerender } = render(view());
    await screen.findByText("Zoom 1");
    const x = screen.getByTestId("x");
    const y = screen.getByTestId("y");
    Object.defineProperty(x, "clientWidth", {
        configurable: true,
        value: 1000,
    });
    Object.defineProperty(y, "clientHeight", {
        configurable: true,
        value: 300,
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 220)));
    expect(y.scrollTop).toBe(0);
    rerender(view(true));
    await waitFor(() => expect(y.scrollTop).toBe(240));
    expect(state.mounts).toHaveBeenCalledOnce();
});

it("retains parsed data and viewport, and removes global workbook input handlers while inactive", async () => {
    const { rerender } = render(<SpreadsheetView documentId="sheet" />);
    await screen.findByText("Zoom 1");
    // The lazy workbook can be visible before its keyboard effect runs.
    await waitFor(() => expect(state.mounts).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: "+", ctrlKey: true });
    expect(screen.getByText("Zoom 1.1")).toBeVisible();
    screen.getByTestId("x").scrollLeft = 180;
    screen.getByTestId("y").scrollTop = 460;
    rerender(<SpreadsheetView documentId="sheet" active={false} />);
    expect(screen.queryByText("Zoom 1.1")).not.toBeInTheDocument();
    const event = new KeyboardEvent("keydown", {
        key: "+",
        ctrlKey: true,
        cancelable: true,
    });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    rerender(<SpreadsheetView documentId="sheet" />);
    expect(screen.getByText("Zoom 1.1")).toBeVisible();
    expect(screen.getByText("Total")).toBeVisible();
    await waitFor(() => {
        expect(screen.getByTestId("x").scrollLeft).toBe(180);
        expect(screen.getByTestId("y").scrollTop).toBe(460);
    });
    expect(state.parse).toHaveBeenCalledTimes(1);
    expect(state.mounts).toHaveBeenCalledTimes(2);
    // Fresh bytes must not restore an old workbook snapshot.
    state.bytes = xlsxBytes();
    await act(async () =>
        rerender(
            <SpreadsheetView documentId="sheet" refetchKey="new-version" />,
        ),
    );
    expect(screen.getByText("Zoom 1")).toBeVisible();
    expect(screen.getByTestId("y").scrollTop).toBe(0);
    expect(state.parse).toHaveBeenCalledTimes(2);
});

it("opens LuckyExcel sheets with keyed images and preserves them when reopening the tab", async () => {
    state.parse.mockImplementation((_file, done) =>
        done({
            sheets: [
                {
                    id: "s1",
                    name: "Budget",
                    data: [],
                    config: {},
                    status: 1,
                    images: {
                        logo: {
                            src: "data:image/png;base64,iVBORw0KGgo=",
                            default: {
                                left: 40,
                                top: 25,
                                width: 160,
                                height: 80,
                            },
                            originWidth: 320,
                            originHeight: 160,
                        },
                    },
                },
            ],
        }),
    );
    const { rerender } = render(<SpreadsheetView documentId="sheet" />);
    const image = await screen.findByRole("img", {
        name: "Embedded spreadsheet image",
    });
    expect(image).toHaveAttribute("width", "160");
    expect(image).toHaveAttribute("height", "80");
    expect(image).toHaveStyle({ left: "40px", top: "25px" });
    rerender(<SpreadsheetView documentId="sheet" active={false} />);
    rerender(<SpreadsheetView documentId="sheet" />);
    expect(
        screen.getByRole("img", { name: "Embedded spreadsheet image" }),
    ).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(state.parse).toHaveBeenCalledTimes(1);
});

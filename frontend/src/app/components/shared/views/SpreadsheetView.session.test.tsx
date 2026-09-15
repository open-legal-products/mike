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
import type { Sheet } from "@fortune-sheet/core";
import type { DocResult } from "@/app/hooks/useFetchSingleDoc";
import { SpreadsheetView } from "./SpreadsheetView";

const state = vi.hoisted(() => ({
    result: null as DocResult,
    parse: vi.fn(),
    mounts: vi.fn(),
}));
vi.mock("@/app/hooks/useFetchSingleDoc", () => ({
    useFetchSingleDoc: () => ({ result: state.result, error: null }),
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
                    getAllSheets: () => [{ ...data[0], zoomRatio: zoom }],
                    getSelection: () => [{ row: [2, 2], column: [3, 3] }],
                    setSelection: vi.fn(),
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
            [data, zoom],
        );
        return (
            <div>
                <span>Zoom {zoom}</span>
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

beforeEach(() => {
    vi.clearAllMocks();
    state.result = { type: "spreadsheet", buffer: new ArrayBuffer(3) };
    state.parse.mockImplementation((_file, done) =>
        done({
            sheets: [
                { id: "s1", name: "Budget", data: [], config: {}, status: 1 },
            ],
        }),
    );
});
afterEach(() => vi.restoreAllMocks());

it("retains parsed data and viewport, and removes global workbook input handlers while inactive", async () => {
    const { rerender } = render(<SpreadsheetView documentId="sheet" />);
    await screen.findByText("Zoom 1");
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
    await waitFor(() => {
        expect(screen.getByTestId("x").scrollLeft).toBe(180);
        expect(screen.getByTestId("y").scrollTop).toBe(460);
    });
    expect(state.parse).toHaveBeenCalledTimes(1);
    expect(state.mounts).toHaveBeenCalledTimes(2);
    // Fresh bytes must not restore an old workbook snapshot.
    state.result = { type: "spreadsheet", buffer: new ArrayBuffer(4) };
    await act(async () =>
        rerender(
            <SpreadsheetView documentId="sheet" refetchKey="new-version" />,
        ),
    );
    expect(screen.getByText("Zoom 1")).toBeVisible();
    expect(screen.getByTestId("y").scrollTop).toBe(0);
    expect(state.parse).toHaveBeenCalledTimes(2);
});

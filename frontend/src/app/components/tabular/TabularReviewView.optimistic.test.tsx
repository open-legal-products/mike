/**
 * Optimistic updates in the review view are reverted when a save fails.
 * These tests pin the part that is easy to get wrong: a revert (and the
 * "Retry" its toast offers) must touch only the item that failed, because
 * the review keeps changing while the request is in flight — another column
 * is edited, a run fills cells in — and the review's columns are saved as
 * one whole config, so a stale snapshot overwrites the server too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
    getTabularReview,
    listProjects,
    streamTabularGeneration,
    updateTabularReview,
} from "@/app/lib/mikeApi";
import type {
    ColumnConfig,
    TabularCell,
    TabularReviewRow,
} from "../shared/types";
import { TRView } from "./TabularReviewView";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

const { tableProps } = vi.hoisted(() => ({
    tableProps: {
        current: null as null | {
            columns: ColumnConfig[];
            cells: TabularCell[];
            rows: TabularReviewRow[];
            onUpdateColumn: (column: ColumnConfig) => void;
            onDeleteColumn: (columnIndex: number) => void;
            onSelectionChange: (ids: string[]) => void;
        },
    },
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getTabularReview: vi.fn(),
    listProjects: vi.fn(),
    updateTabularReview: vi.fn(),
    streamTabularGeneration: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "me@example.com" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    // Degraded key state fails open, which is what lets the test press Run
    // without standing up the whole model-availability fixture.
    useUserProfile: () => ({
        profile: {},
        loading: false,
        apiKeysDegraded: true,
    }),
}));
vi.mock("./TRChatPanel", () => ({ TRChatPanel: () => <div /> }));
vi.mock("./TRSidePanel", () => ({ TRSidePanel: () => <div /> }));
vi.mock("./TRTable", () => ({
    // A stand-in for the grid: it publishes the props the view hands it so a
    // test can drive a column edit, and renders the state it was given so a
    // test can read what the user would see.
    TRTable: (props: NonNullable<typeof tableProps.current>) => {
        tableProps.current = props;
        return (
            <div>
                {props.columns.map((column) => (
                    <div key={column.index} data-testid={`col-${column.index}`}>
                        {column.name}
                    </div>
                ))}
                {props.rows.map((row) => (
                    <div key={row.id} data-testid={`row-${row.id}`} />
                ))}
                {props.cells.map((cell) => (
                    <div key={cell.id} data-testid={`cell-${cell.id}`}>
                        {cell.content?.summary ?? ""}
                    </div>
                ))}
            </div>
        );
    },
}));

const columnA: ColumnConfig = { index: 0, name: "Parties", prompt: "who?" };
const columnB: ColumnConfig = { index: 1, name: "Term", prompt: "how long?" };

function makeRow(id: string): TabularReviewRow {
    return {
        id,
        review_id: "review-1",
        label: id,
        row_type: "document",
        folder_id: null,
        library_folder_id: null,
        document_id: `doc-${id}`,
        sort_index: 0,
        source_document_ids: [`doc-${id}`],
    };
}

function makeCell(rowId: string, summary: string | null): TabularCell {
    return {
        id: `${rowId}-0`,
        review_id: "review-1",
        row_id: rowId,
        document_id: `doc-${rowId}`,
        column_index: 0,
        content: summary ? { summary } : null,
        status: summary ? "done" : "pending",
        created_at: "2026-01-01T00:00:00.000Z",
    };
}

function detail(overrides?: {
    columns?: ColumnConfig[];
    rows?: TabularReviewRow[];
    cells?: TabularCell[];
    isRunning?: boolean;
}) {
    const rows = overrides?.rows ?? [];
    return {
        review: {
            id: "review-1",
            title: "Diligence",
            // The gates in this view are role-based; an owner may reshape.
            access_role: "owner",
            is_owner: true,
            model: "claude-sonnet-4-5",
            columns_config: overrides?.columns ?? [columnA, columnB],
            is_running: overrides?.isRunning ?? false,
            updated_at: "2026-01-01T00:00:00.000Z",
        },
        cells: overrides?.cells ?? [],
        rows,
        documents: rows.map((row) => ({
            id: `doc-${row.id}`,
            name: row.label,
        })),
    } as unknown as Awaited<ReturnType<typeof getTabularReview>>;
}

/** A promise a test resolves or rejects by hand. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function savedColumns(call: number): ColumnConfig[] {
    const patch = vi.mocked(updateTabularReview).mock.calls[call][1] as {
        columns_config?: ColumnConfig[];
    };
    return patch.columns_config ?? [];
}

describe("TRView optimistic reverts", () => {
    beforeEach(() => {
        clearToasts();
        tableProps.current = null;
        vi.clearAllMocks();
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                disconnect() {}
            },
        );
        vi.stubGlobal("matchMedia", (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
        vi.mocked(getTabularReview).mockResolvedValue(detail());
        vi.mocked(listProjects).mockResolvedValue([]);
    });
    afterEach(() => {
        clearToasts();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function renderView() {
        render(
            <>
                <TRView reviewId="review-1" />
                <ToastViewportUI />
            </>,
        );
        expect(await screen.findByTestId("col-0")).toHaveTextContent("Parties");
        return tableProps.current!;
    }

    it("keeps a concurrent column edit when another column's save fails", async () => {
        const first = deferred<unknown>();
        const second = deferred<unknown>();
        vi.mocked(updateTabularReview)
            .mockReturnValueOnce(
                first.promise as ReturnType<typeof updateTabularReview>,
            )
            .mockReturnValueOnce(
                second.promise as ReturnType<typeof updateTabularReview>,
            );

        await renderView();
        // Two edits in flight at once: rename column A, then column B.
        act(() => {
            tableProps.current!.onUpdateColumn({ ...columnA, name: "Sellers" });
        });
        act(() => {
            tableProps.current!.onUpdateColumn({ ...columnB, name: "Length" });
        });

        // The second save carries the first edit too — it is one config.
        expect(savedColumns(1)).toEqual([
            { ...columnA, name: "Sellers" },
            { ...columnB, name: "Length" },
        ]);

        await act(async () => {
            second.resolve({ columns_config: savedColumns(1) });
            await Promise.resolve();
        });
        await act(async () => {
            first.reject(new Error("boom"));
            await Promise.resolve();
        });

        // Only the failed column goes back to its old name.
        expect(await screen.findByTestId("col-0")).toHaveTextContent("Parties");
        expect(screen.getByTestId("col-1")).toHaveTextContent("Length");
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Couldn't save the column",
        );
    });

    it("retries a failed column edit against the current config", async () => {
        const first = deferred<unknown>();
        vi.mocked(updateTabularReview).mockReturnValueOnce(
            first.promise as ReturnType<typeof updateTabularReview>,
        );
        vi.mocked(updateTabularReview).mockImplementation(
            async (_id, patch) =>
                patch as unknown as Awaited<
                    ReturnType<typeof updateTabularReview>
                >,
        );

        const user = userEvent.setup();
        await renderView();
        act(() => {
            tableProps.current!.onUpdateColumn({ ...columnA, name: "Sellers" });
        });
        await act(async () => {
            first.reject(new Error("boom"));
            await Promise.resolve();
        });
        expect(await screen.findByRole("alert")).toBeInTheDocument();

        // The user changes a different column before pressing Retry.
        await act(async () => {
            tableProps.current!.onUpdateColumn({ ...columnB, name: "Length" });
        });
        await user.click(screen.getByRole("button", { name: "Retry" }));

        // The retry re-sends its own column merged onto the config as it is
        // now, instead of the whole snapshot it failed with.
        const retried = savedColumns(
            vi.mocked(updateTabularReview).mock.calls.length - 1,
        );
        expect(retried).toEqual([
            { ...columnA, name: "Sellers" },
            { ...columnB, name: "Length" },
        ]);
        expect(screen.getByTestId("col-1")).toHaveTextContent("Length");
    });

    it("retries a failed run against the review as it is now", async () => {
        const rows = [makeRow("row-1")];
        vi.mocked(getTabularReview).mockResolvedValue(
            detail({ rows, cells: [makeCell("row-1", null)] }),
        );
        vi.mocked(streamTabularGeneration).mockRejectedValue(new Error("boom"));
        vi.mocked(updateTabularReview).mockImplementation(
            async (_id, patch) =>
                ({
                    ...(patch as object),
                    updated_at: "2026-03-03T00:00:00.000Z",
                }) as unknown as Awaited<
                    ReturnType<typeof updateTabularReview>
                >,
        );

        const user = userEvent.setup();
        await renderView();
        await user.click(screen.getByRole("button", { name: /Run review/ }));
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Couldn't run this review",
        );

        // The review moves on before the user presses Retry: a column edit
        // lands and the server hands back a newer `updated_at`.
        await act(async () => {
            tableProps.current!.onUpdateColumn({ ...columnB, name: "Length" });
        });
        await user.click(screen.getByRole("button", { name: "Retry" }));

        // The retry re-enters the current handler, so it sends the review's
        // current version — the frozen one would be refused as stale.
        await waitFor(() =>
            expect(streamTabularGeneration).toHaveBeenCalledTimes(2),
        );
        expect(
            vi.mocked(streamTabularGeneration).mock.calls[1][1],
        ).toBe("2026-03-03T00:00:00.000Z");
    });

    it("keeps the cells a run produced when a document removal fails", async () => {
        const rows = [makeRow("row-1"), makeRow("row-2")];
        vi.mocked(getTabularReview).mockResolvedValue(
            detail({
                rows,
                cells: [makeCell("row-1", null), makeCell("row-2", null)],
            }),
        );
        // A run in flight, feeding one cell_update frame before the removal.
        let push: (chunk: string) => void = () => {};
        let close: () => void = () => {};
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder();
                push = (chunk) => controller.enqueue(encoder.encode(chunk));
                close = () => controller.close();
            },
        });
        vi.mocked(streamTabularGeneration).mockResolvedValue(
            new Response(body, { status: 200 }),
        );
        const removal = deferred<unknown>();
        vi.mocked(updateTabularReview).mockReturnValue(
            removal.promise as ReturnType<typeof updateTabularReview>,
        );

        const user = userEvent.setup();
        await renderView();
        await user.click(screen.getByRole("button", { name: /Run review/ }));
        expect(streamTabularGeneration).toHaveBeenCalled();

        // Remove the other row while the run keeps going.
        act(() => {
            tableProps.current!.onSelectionChange(["row-1"]);
        });
        // The row actions live in the toolbar's overflow menu at this width.
        await user.click(
            screen.getByRole("button", { name: "Toolbar actions" }),
        );
        await user.click(screen.getAllByRole("button", { name: "Delete" })[0]);
        expect(screen.queryByTestId("row-row-1")).toBeNull();

        // The run produces a cell WHILE the removal is in flight: it is not
        // in the snapshot the removal took before it started.
        await act(async () => {
            push(
                `data: ${JSON.stringify({
                    type: "cell_update",
                    row_id: "row-2",
                    column_index: 0,
                    content: { summary: "Produced by the run" },
                    status: "done",
                })}\n\n`,
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await waitFor(() =>
            expect(screen.getByTestId("cell-row-2-0")).toHaveTextContent(
                "Produced by the run",
            ),
        );

        // Now fail the removal.
        await act(async () => {
            removal.reject(new Error("boom"));
            await Promise.resolve();
        });

        // The row comes back, and the run's result is still on screen.
        expect(await screen.findByTestId("row-row-1")).toBeInTheDocument();
        expect(screen.getByTestId("cell-row-2-0")).toHaveTextContent(
            "Produced by the run",
        );
        // The toolbar's overflow menu is still open, which hides the rest of
        // the document from role queries — read the toast by its test id.
        expect(await screen.findByTestId("toast")).toHaveTextContent(
            "Couldn't remove the document",
        );
        await act(async () => {
            close();
        });
    });
});

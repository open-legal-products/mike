import { AuditHistory } from "@/app/components/history/AuditHistory";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadUserExport,
  getAuditHistory,
  getUserExportStatus,
  startUserExport,
  type AuditEvent,
} from "@/app/lib/mikeApi";
import HistoryPage from "./page";

// The CSV now comes from the durable export job, so the page drives the
// start/poll/download wrappers instead of one blob request.
vi.mock("@/app/lib/mikeApi", () => ({
  getAuditHistory: vi.fn(),
  startUserExport: vi.fn(),
  getUserExportStatus: vi.fn(),
  downloadUserExport: vi.fn(),
}));

const EVENT: AuditEvent = {
  id: "event-1",
  created_at: "2026-08-10T08:30:00.000Z",
  user_display_name: "Alex Lawyer",
  user_email: "lawyer@example.com",
  action: "document.edited",
  status: "completed",
  title: "Share purchase agreement",
  surface: "project",
  project_id: "project-1",
  chat_id: null,
  document_id: "document-1",
  review_id: null,
  model: "gpt-5",
  detail: null,
};

const mockedGetAuditHistory = vi.mocked(getAuditHistory);
const mockedStartUserExport = vi.mocked(startUserExport);
const mockedGetUserExportStatus = vi.mocked(getUserExportStatus);
const mockedDownloadUserExport = vi.mocked(downloadUserExport);

function expectedDefaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 30);
  return expectedDateRange(from, to);
}

function expectedDateRange(from: Date, to: Date) {
  const localValue = (date: Date) => {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  };
  return { from: localValue(from), to: localValue(to) };
}

function observeLoadMore() {
  let callback: IntersectionObserverCallback;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  return () =>
    callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
}

describe("HistoryPage", () => {
  it("scopes the reused organization history page to its organization", async () => {
    render(<AuditHistory orgId="org-a" onBack={() => {}} />);
    await waitFor(() => expect(mockedGetAuditHistory).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", page: 1 }), expect.anything(),
    ));
    expect(screen.getByRole("button", { name: "Audit log actions" })).toBeInTheDocument();
    expect(screen.getAllByText("Organization Settings").length).toBeGreaterThan(0);
  });

  beforeEach(() => {
    // Pin the clock — Date only, so user-event's real timers keep working.
    // These tests derive calendar expectations from "today": the default
    // range opens the picker on the month of today−30, and the range test
    // clicks today−25, which is only on that grid when the month's trailing
    // outside-days happen to include it. That made the suite green or red by
    // calendar alignment (first failure: CI running just past midnight UTC
    // on 2026-08-27, where today−30 shows July but today−25 is Aug 2). A
    // mid-month date keeps every derived day inside the visible grids,
    // deterministically, in every timezone.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    mockedGetAuditHistory.mockResolvedValue({
      events: [EVENT],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    mockedStartUserExport.mockResolvedValue({ export_id: "export-1" });
    mockedGetUserExportStatus.mockResolvedValue({
      status: "done",
      filename: "history-export.csv",
    });
    mockedDownloadUserExport.mockResolvedValue({
      blob: new Blob(["history"]),
      filename: "history.csv",
    });
    Object.defineProperties(URL, {
      createObjectURL: {
        configurable: true,
        value: vi.fn(() => "blob:history"),
      },
      revokeObjectURL: {
        configurable: true,
        value: vi.fn(),
      },
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the shared page header, toolbar, and table controls", async () => {
    render(<HistoryPage />);

    expect(
      screen.getByRole("heading", { name: "History" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Search history…" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "History actions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select date range" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "7 days" })).toBeNull();
    expect(screen.queryByRole("button", { name: "30 days" })).toBeNull();

    expect(await screen.findByText("Alex Lawyer")).toBeInTheDocument();
    expect(screen.getByText("Share purchase agreement")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by status" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Username")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Alex Lawyer")).toHaveClass("text-xs");
    expect(screen.getByText("lawyer@example.com")).toHaveClass(
      "ml-auto",
      "w-52",
      "text-xs",
    );
    expect(screen.getByText("Completed")).toHaveClass("text-green-600");
    expect(screen.getByText("Completed")).not.toHaveClass("rounded-full");
    expect(screen.getByTestId("status-dot-event-1")).toHaveClass(
      "rounded-full",
      "border-white/80",
      "bg-green-400/80",
    );
    expect(screen.getByText("gpt-5")).toHaveClass("w-28", "text-xs");
    expect(screen.getByText("Email").parentElement).toHaveClass("ml-auto");
    expect(
      screen.getByRole("button", { name: "Sort by email" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by type" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by application" }),
    ).toBeInTheDocument();
  });

  it("defaults to the previous 30 days and sends header controls to the audit query", async () => {
    const user = userEvent.setup();
    render(<HistoryPage />);
    await screen.findByText("Alex Lawyer");

    expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...expectedDefaultDateRange(),
        page: 1,
      }),
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await user.click(screen.getByRole("menuitem", { name: "Completed" }));
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "completed", page: 1 }),
        expect.any(AbortSignal),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Sort by title" }));
    await user.click(screen.getByText("Ascending"));
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "completed",
          sortBy: "title",
          sortDirection: "asc",
        }),
        expect.any(AbortSignal),
      ),
    );

    expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "completed",
        sortBy: "title",
        sortDirection: "asc",
        ...expectedDefaultDateRange(),
      }),
      expect.any(AbortSignal),
    );
  });

  it("uses a liquid range calendar and exports the selected dates", async () => {
    const user = userEvent.setup();
    render(<HistoryPage />);
    await screen.findByText("Alex Lawyer");

    await user.click(screen.getByRole("button", { name: "Select date range" }));
    expect(screen.getByRole("menu")).toHaveClass("liquid-glass-float");
    expect(screen.getByRole("menu")).toHaveAttribute("data-align", "start");
    expect(screen.getAllByRole("grid")).toHaveLength(2);
    expect(
      screen.getByRole("region", { name: "Start date" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "End date" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Start date" })).toHaveClass(
      "w-56",
    );
    expect(screen.getByRole("region", { name: "End date" })).toHaveClass(
      "w-56",
    );
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    expect(confirmButton).toBeDisabled();
    const selectedStartCell = screen
      .getByTestId("start-date-picker")
      .querySelector('[data-selected="true"]');
    expect(selectedStartCell).toHaveClass(
      "[&>button]:!bg-gray-200",
      "[&>button]:!text-gray-900",
    );

    const rangeEnd = new Date();
    rangeEnd.setDate(rangeEnd.getDate() - 1);
    const rangeStart = new Date();
    rangeStart.setDate(rangeStart.getDate() - 29);
    const { from: selectedFrom, to: selectedTo } = expectedDateRange(
      rangeStart,
      rangeEnd,
    );
    const startButton = screen
      .getByTestId("start-date-picker")
      .querySelector<HTMLButtonElement>(`[data-day="${selectedFrom}"] button`);
    const endButton = screen
      .getByTestId("end-date-picker")
      .querySelector<HTMLButtonElement>(`[data-day="${selectedTo}"] button`);
    expect(startButton).not.toBeNull();
    expect(endButton).not.toBeNull();

    const callsBeforeSelection = mockedGetAuditHistory.mock.calls.length;
    await user.click(startButton!);
    await user.click(endButton!);
    expect(confirmButton).toBeEnabled();
    expect(mockedGetAuditHistory).toHaveBeenCalledTimes(callsBeforeSelection);

    await user.click(confirmButton);
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          from: selectedFrom,
          to: selectedTo,
          page: 1,
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "History actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() =>
      expect(mockedStartUserExport).toHaveBeenCalledWith(
        "audit-csv",
        expect.objectContaining({
          from: selectedFrom,
          to: selectedTo,
        }),
      ),
    );
    await waitFor(() =>
      expect(mockedDownloadUserExport).toHaveBeenCalledWith("export-1"),
    );
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:history");
  });

  it("polls the export job until it finishes before downloading", async () => {
    const user = userEvent.setup();
    mockedGetUserExportStatus
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({
        status: "done",
        filename: "history-export.csv",
      });

    render(<HistoryPage />);
    await screen.findByText("Alex Lawyer");
    await user.click(screen.getByRole("button", { name: "History actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() =>
      expect(mockedGetUserExportStatus).toHaveBeenCalledTimes(2),
    );
    expect(mockedDownloadUserExport).toHaveBeenCalledWith("export-1");
  });

  it("keeps the export modal open with a retryable error when the job fails", async () => {
    const user = userEvent.setup();
    mockedGetUserExportStatus.mockResolvedValue({ status: "failed" });

    render(<HistoryPage />);
    await screen.findByText("Alex Lawyer");
    await user.click(screen.getByRole("button", { name: "History actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your history could not be exported.",
    );
    expect(
      screen.getByText("Your history could not be exported. Please try again."),
    ).toBeInTheDocument();
    expect(mockedDownloadUserExport).not.toHaveBeenCalled();
    // The button returns to its idle state instead of spinning forever.
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  });

  it("shows the history clock in the empty table placeholder", async () => {
    mockedGetAuditHistory.mockResolvedValue({
      events: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });

    render(<HistoryPage />);

    expect(await screen.findByText("No history yet")).toBeInTheDocument();
    expect(screen.getByText("No history yet").parentElement).toHaveClass(
      "max-w-[260px]",
      "items-start",
      "text-left",
    );
    expect(screen.getByTestId("history-empty-icon")).toHaveAttribute(
      "src",
      expect.stringContaining("/icons/features/history.svg"),
    );
  });

  it("keeps the email visible when the profile has no display name", async () => {
    mockedGetAuditHistory.mockResolvedValue({
      events: [{ ...EVENT, user_display_name: null }],
      total: 1,
      page: 1,
      pageSize: 50,
    });

    render(<HistoryPage />);

    expect(await screen.findByText("lawyer@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Alex Lawyer")).toBeNull();
  });

  it("automatically appends the next page once and stops at the end", async () => {
    const intersect = observeLoadMore();
    let resolveNext!: (
      value: Awaited<ReturnType<typeof getAuditHistory>>,
    ) => void;
    mockedGetAuditHistory
      .mockResolvedValueOnce({
        events: [EVENT],
        total: 2,
        page: 1,
        pageSize: 1,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNext = resolve;
          }),
      );
    render(<HistoryPage />);
    await screen.findByText(EVENT.title!);

    act(() => {
      intersect();
      intersect();
    });
    expect(mockedGetAuditHistory).toHaveBeenCalledTimes(2);
    expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
      expect.any(AbortSignal),
    );
    expect(screen.getByText(EVENT.title!)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

    await act(async () =>
      resolveNext({
        events: [{ ...EVENT, id: "event-2", title: "Second event" }],
        total: 2,
        page: 2,
        pageSize: 1,
      }),
    );
    expect(screen.getByText(EVENT.title!)).toBeInTheDocument();
    expect(screen.getByText("Second event")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });

  it("keeps loaded rows and retries the same page after an automatic-load failure", async () => {
    const intersect = observeLoadMore();
    mockedGetAuditHistory
      .mockResolvedValueOnce({
        events: [EVENT],
        total: 2,
        page: 1,
        pageSize: 1,
      })
      .mockRejectedValueOnce(new Error("Internal database detail"))
      .mockResolvedValueOnce({
        events: [{ ...EVENT, id: "event-2", title: "Second event" }],
        total: 2,
        page: 2,
        pageSize: 1,
      });
    render(<HistoryPage />);
    await screen.findByText(EVENT.title!);
    act(intersect);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry loading" }),
    );
    expect(await screen.findByText("Second event")).toBeInTheDocument();
    expect(screen.getByText(EVENT.title!)).toBeInTheDocument();
    expect(
      mockedGetAuditHistory.mock.calls.map(([query]) => query.page),
    ).toEqual([1, 2, 2]);
    expect(
      screen.queryByText("Internal database detail"),
    ).not.toBeInTheDocument();
  });

  it("discards an in-flight next page when a filter changes and restarts automatic loading", async () => {
    const user = userEvent.setup();
    const intersect = observeLoadMore();
    let resolveNext!: (
      value: Awaited<ReturnType<typeof getAuditHistory>>,
    ) => void;
    const filtered = {
      ...EVENT,
      id: "filtered",
      title: "Filtered event",
      status: "failed",
    };
    mockedGetAuditHistory
      .mockResolvedValueOnce({
        events: [EVENT],
        total: 2,
        page: 1,
        pageSize: 1,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNext = resolve;
          }),
      )
      .mockResolvedValueOnce({
        events: [filtered],
        total: 2,
        page: 1,
        pageSize: 1,
      })
      .mockResolvedValueOnce({
        events: [
          { ...filtered, id: "filtered-2", title: "Next filtered event" },
        ],
        total: 2,
        page: 2,
        pageSize: 1,
      });
    render(<HistoryPage />);
    await screen.findByText(EVENT.title!);
    act(intersect);
    const oldSignal = mockedGetAuditHistory.mock.calls[1][1]!;
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await user.click(screen.getByRole("menuitem", { name: "Failed" }));
    expect(await screen.findByText("Filtered event")).toBeInTheDocument();
    expect(oldSignal.aborted).toBe(true);
    await act(async () =>
      resolveNext({
        events: [{ ...EVENT, id: "stale", title: "Stale event" }],
        total: 2,
        page: 2,
        pageSize: 1,
      }),
    );
    expect(screen.queryByText("Stale event")).not.toBeInTheDocument();
    expect(screen.queryByText(EVENT.title!)).not.toBeInTheDocument();
    act(intersect);
    expect(await screen.findByText("Next filtered event")).toBeInTheDocument();
    expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", page: 2 }),
      expect.any(AbortSignal),
    );
  });

  it("opens full event details from a row and restores focus on close", async () => {
    const user = userEvent.setup();
    const email = `${"long.email.".repeat(12)}@example.com`;
    mockedGetAuditHistory.mockResolvedValue({
      events: [
        {
          ...EVENT,
          user_email: email,
          detail: {
            workflow_id: "workflow-123",
            enabled: false,
            model_count: 0,
            settings: { mode: "review" },
          },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    render(<HistoryPage />);
    const row = await screen.findByRole("button", {
      name: `View details for ${EVENT.title}`,
    });
    expect(
      screen.queryByRole("link", { name: EVENT.title! }),
    ).not.toBeInTheDocument();
    await user.click(row);
    const modal = within(screen.getByRole("dialog", { name: "Event details" }));
    expect(modal.getByText(email)).toHaveClass("[overflow-wrap:anywhere]");
    expect(modal.getByText("gpt-5")).toBeInTheDocument();
    expect(modal.getByText("workflow-123")).toBeInTheDocument();
    expect(modal.getByText("No")).toBeInTheDocument();
    expect(modal.getByText("0")).toBeInTheDocument();
    expect(modal.getByText(/"mode": "review"/)).toBeInTheDocument();
    expect(modal.getByRole("link", { name: "Open project" })).toHaveAttribute(
      "href",
      "/projects/project-1",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("dialog", { name: "Event details" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.keyboard(" ");
    expect(
      screen.getByRole("dialog", { name: "Event details" }),
    ).toBeInTheDocument();
  });

  it("opens details for events without a title, related destination, or metadata", async () => {
    mockedGetAuditHistory.mockResolvedValue({
      events: [{ ...EVENT, title: null, project_id: null, document_id: null }],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    render(<HistoryPage />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "View details for Document edit",
      }),
    );
    const modal = within(screen.getByRole("dialog", { name: "Event details" }));
    expect(
      modal.getByRole("heading", { name: "Document edit" }),
    ).toBeInTheDocument();
    expect(modal.queryByRole("link")).not.toBeInTheDocument();
    expect(modal.queryByText("Additional details")).not.toBeInTheDocument();
  });

  it("exports the modal's chosen period without changing the table dates or dropping filters", async () => {
    const user = userEvent.setup();
    render(<HistoryPage />);
    await screen.findByText(EVENT.title!);
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await user.click(screen.getByRole("menuitem", { name: "Completed" }));
    await user.click(screen.getByRole("button", { name: "Sort by title" }));
    await user.click(screen.getByRole("menuitem", { name: "Ascending" }));
    await user.click(screen.getByRole("button", { name: "Search history…" }));
    await user.type(
      screen.getByPlaceholderText("Search history…"),
      "agreement",
    );
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "agreement" }),
        expect.any(AbortSignal),
      ),
    );
    const tableCalls = mockedGetAuditHistory.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "History actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    const modal = within(
      screen.getByRole("dialog", { name: "Export history" }),
    );
    await user.click(
      modal
        .getByTestId("start-date-picker")
        .querySelector<HTMLButtonElement>('[data-day="2026-05-17"] button')!,
    );
    await user.click(
      modal
        .getByTestId("end-date-picker")
        .querySelector<HTMLButtonElement>('[data-day="2026-06-14"] button')!,
    );
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    expect(mockedGetAuditHistory).toHaveBeenCalledTimes(tableCalls);
    expect(
      modal
        .getByTestId("end-date-picker")
        .querySelector('[data-day="2026-06-16"] button'),
    ).toBeDisabled();
    await user.click(modal.getByRole("button", { name: "Export CSV" }));
    await waitFor(() =>
      expect(mockedStartUserExport).toHaveBeenCalledWith(
        "audit-csv",
        expect.objectContaining({
          from: "2026-05-17",
          to: "2026-06-14",
          status: "completed",
          q: "agreement",
          sort_by: "title",
          sort_dir: "asc",
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mockedGetAuditHistory).toHaveBeenCalledTimes(tableCalls);
    expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
      expect.objectContaining(expectedDefaultDateRange()),
      expect.any(AbortSignal),
    );
  });

  it("cancels export without creating a job and resets the draft when reopened", async () => {
    const user = userEvent.setup();
    render(<HistoryPage />);
    await screen.findByText(EVENT.title!);
    await user.click(screen.getByRole("button", { name: "History actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    await user.click(
      screen
        .getByTestId("start-date-picker")
        .querySelector<HTMLButtonElement>('[data-day="2026-05-17"] button')!,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "History actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(
      screen
        .getByTestId("start-date-picker")
        .querySelector('[data-day="2026-05-16"]'),
    ).toHaveAttribute("data-selected", "true");
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportAuditHistory,
  getAuditHistory,
  type AuditEvent,
} from "@/app/lib/mikeApi";
import HistoryPage from "./page";

vi.mock("@/app/lib/mikeApi", () => ({
  getAuditHistory: vi.fn(),
  exportAuditHistory: vi.fn(),
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
const mockedExportAuditHistory = vi.mocked(exportAuditHistory);

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

describe("HistoryPage", () => {
  beforeEach(() => {
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
    mockedExportAuditHistory.mockResolvedValue({
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
    vi.restoreAllMocks();
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
      screen.getByRole("button", { name: "Export history" }),
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
      "backdrop-blur-xl",
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

    await user.click(screen.getByRole("button", { name: "Export history" }));
    await waitFor(() =>
      expect(mockedExportAuditHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          from: selectedFrom,
          to: selectedTo,
        }),
      ),
    );
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:history");
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
});

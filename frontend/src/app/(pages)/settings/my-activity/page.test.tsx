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
  getAuditActors,
  getUserExportStatus,
  startUserExport,
  type AuditEvent,
} from "@/app/lib/mikeApi";
import MyActivitySettingsPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

// The CSV now comes from the durable export job, so the page drives the
// start/poll/download wrappers instead of one blob request.
vi.mock("@/app/lib/mikeApi", () => ({
  getAuditHistory: vi.fn(),
  getAuditActors: vi.fn(),
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
  from.setDate(to.getDate() - 29);
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

describe("MyActivitySettingsPage", () => {
  it("uses organization-specific loading and empty-state messages", async () => {
    mockedGetAuditHistory.mockRejectedValueOnce(new Error("unavailable"));
    const { unmount } = render(<AuditHistory orgId="org-a" />);
    expect(await screen.findByText("The audit log could not be loaded.")).toBeInTheDocument();
    unmount();
    mockedGetAuditHistory.mockResolvedValue({ events: [], total: 0, page: 1, pageSize: 50 });
    render(<AuditHistory orgId="org-a" />);
    expect(await screen.findByText("Actions taken in this organization appear here.")).toBeInTheDocument();
  });

  it("uses organization-specific export failure text", async () => {
    const user = userEvent.setup();
    mockedGetUserExportStatus.mockResolvedValue({ status: "failed" });
    render(<AuditHistory orgId="org-a" />);
    await screen.findByText(EVENT.title!);
    await user.click(screen.getByRole("button", { name: "Audit log actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The audit log could not be exported. Please try again.");
  });

  it("shows the affected member's name and initials, keeping email in the tooltip", async () => {
    mockedGetAuditHistory.mockResolvedValue({
      events: [{ ...EVENT, action: "org.member.role_changed", title: "jamie@example.com", affected_user_display_name: "Jamie Morgan" }],
      total: 1, page: 1, pageSize: 50,
    });
    render(<AuditHistory orgId="org-a" />);
    expect(await screen.findByRole("button", { name: "View details for Jamie Morgan" })).toBeInTheDocument();
    const cell = screen.getByTitle("Member: Jamie Morgan (jamie@example.com)");
    expect(cell).toHaveTextContent("Jamie Morgan");
    expect(cell).not.toHaveTextContent("jamie@example.com");
    expect(within(cell).getByRole("img", { name: "Jamie Morgan" })).toHaveTextContent("JM");
  });
  it("scopes the reused organization history page to its organization", async () => {
    render(<AuditHistory orgId="org-a" onBack={() => {}} />);
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a", page: 1 }),
        expect.anything(),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Audit log actions" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Organization").length).toBeGreaterThan(
      0,
    );
  });

  it("renders actor photos and falls back to the shared monogram in organization rows", async () => {
    const photo = "data:image/png;base64,cGhvdG8=";
    mockedGetAuditHistory.mockResolvedValue({
      events: [{ ...EVENT, user_profile_photo: photo }],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    render(<AuditHistory orgId="org-a" />);
    const avatar = await screen.findByRole("img", { name: "Alex Lawyer" });
    expect(avatar.querySelector("img")).toHaveAttribute("src", photo);
    fireEvent.error(avatar.querySelector("img")!);
    expect(avatar).toHaveTextContent("AL");
    expect(avatar.querySelector("img")).toBeNull();
  });

  beforeEach(() => {
    // Pin local calendar dates while retaining real timers for user-event.
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
      filename: "my-activity.csv",
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
    render(<MyActivitySettingsPage />);

    expect(screen.getAllByText("My Activity").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Settings", { exact: true }).length,
    ).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Settings" }),
    );
    expect(push).toHaveBeenCalledWith("/settings");
    expect(
      screen.getByRole("button", { name: "Search my activity…" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "My Activity actions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Select date range:/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "7 days" })).toBeNull();
    expect(screen.queryByRole("button", { name: "30 days" })).toBeNull();

    expect(await screen.findByText(EVENT.title!)).toBeInTheDocument();
    expect(screen.getByText("Share purchase agreement")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by status" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Username")).not.toBeInTheDocument();
    expect(screen.queryByText("Email")).not.toBeInTheDocument();
    expect(
      screen.queryByText(EVENT.user_display_name!),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(EVENT.user_email!)).not.toBeInTheDocument();
    expect(screen.getByText("Completed").parentElement).toHaveClass("text-gray-700");
    expect(screen.getByText("Completed")).not.toHaveClass("rounded-full");
    expect(screen.getByTestId("status-dot-event-1")).toHaveClass(
      "rounded-full",
      "border-white/80",
      "bg-green-400/80",
    );
    expect(screen.queryByText("gpt-5")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sort by email" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by action" }),
    ).toBeInTheDocument();
    const applicationHeader = screen.getByText("Application", {
      exact: true,
    }).parentElement!;
    expect(
      within(applicationHeader).getByRole("button", {
        name: "Filter by application",
      }),
    ).toBeInTheDocument();
    const row = screen.getByRole("button", {
      name: `View details for ${EVENT.title}`,
    });
    expect(within(row).getByText("Project", { exact: true })).toBeVisible();
  });

  it("defaults to the previous 30 days and sends header controls to the audit query", async () => {
    const user = userEvent.setup();
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);

    expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ...expectedDefaultDateRange(),
        page: 1,
      }),
      expect.any(AbortSignal),
    );

    await user.click(
      screen.getByRole("button", { name: "Filter by application" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Word" }),
    );
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ surface: "word", page: 1 }),
        expect.any(AbortSignal),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Filter by application" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "All applications" }));
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ surface: undefined, page: 1 }),
        expect.any(AbortSignal),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await user.click(screen.getByRole("menuitem", { name: "Completed" }));
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "completed", page: 1 }),
        expect.any(AbortSignal),
      ),
    );

    await user.click(
      screen.getByRole("button", { name: "Sort by affected" }),
    );
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

  it("filters an exact organization actor on the server and carries the filter into exports", async () => {
    const user = userEvent.setup();
    vi.mocked(getAuditActors).mockResolvedValue({ users: [{ user_id: "actor-1", display_name: "Alex Lawyer", email: "lawyer@example.com", profile_photo: null }], nextOffset: null });
    render(<AuditHistory orgId="org-a" />);
    await screen.findByText(EVENT.title!);
    expect(screen.getByText("Performed by")).toBeInTheDocument();
    expect(screen.queryByText("Email")).not.toBeInTheDocument();
    expect(screen.getByText(EVENT.user_display_name!)).toBeVisible();
    expect(screen.queryByText(EVENT.user_email!)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sort by email" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: `Select ${EVENT.title}` }),
    );
    await user.click(screen.getByRole("button", { name: "Filter by person" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search people" }),
      "  Alex  ",
    );
    await user.click(
      await screen.findByRole("button", { name: /Alex Lawyer.*lawyer@example.com/ }),
    );
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ orgId: "org-a", actorUserId: "actor-1", page: 1 }),
        expect.any(AbortSignal),
      ),
    );
    expect(
      screen.getByRole("checkbox", { name: `Select ${EVENT.title}` }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Filter by person" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Audit log actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Export" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Export CSV" }),
    );
    await waitFor(() =>
      expect(mockedStartUserExport).toHaveBeenCalledWith(
        "audit-csv",
        expect.objectContaining({ org_id: "org-a", actor_user_id: "actor-1" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Filter by person" }));
    expect(
      screen.getByRole("searchbox", { name: "Search people" }),
    ).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "All people" }));
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ actorUserId: undefined, page: 1 }),
        expect.any(AbortSignal),
      ),
    );
  });

  it("selects loaded entries without opening details and keeps all action menus in sync", async () => {
    const user = userEvent.setup();
    mockedGetAuditHistory.mockResolvedValue({
      events: [EVENT, { ...EVENT, id: "event-2", title: "Second entry" }],
      total: 2,
      page: 1,
      pageSize: 50,
    });
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    const first = screen.getByRole("checkbox", {
      name: `Select ${EVENT.title}`,
    });
    first.focus();
    await user.keyboard(" ");
    expect(first).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const all = screen.getByRole("checkbox", {
      name: "Select all loaded entries",
    });
    expect(all).toBePartiallyChecked();
    await user.click(all);
    expect(all).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Second entry" }),
    ).toBeChecked();
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Actions" }),
    );
    const labels = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(labels).toEqual(["Deselect rows", "Export selected"]);
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(
      screen.getByRole("button", { name: `View details for ${EVENT.title}` }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(labels);
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: `Actions for ${EVENT.title}` }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(labels);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Export selected" }));
    await waitFor(() =>
      expect(mockedStartUserExport).toHaveBeenCalledWith("audit-csv", {
        event_ids: ["event-1", "event-2"],
        sort_by: undefined,
        sort_dir: undefined,
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(mockedDownloadUserExport).toHaveBeenCalled());
    await user.click(
      screen.getByRole("button", { name: "Actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Deselect rows" }));
    expect(all).not.toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Actions" }),
    ).not.toBeInTheDocument();
  });

  it("offers details, related navigation, and a scoped single-entry export", async () => {
    const user = userEvent.setup();
    render(<AuditHistory orgId="org-a" />);
    const trigger = await screen.findByRole("button", {
      name: `Actions for ${EVENT.title}`,
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Open project" }),
    ).toHaveAttribute("href", "/projects/project-1");
    await user.click(screen.getByRole("menuitem", { name: "View details" }));
    expect(
      screen.getByRole("dialog", { name: "Event details" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(trigger);
    await user.click(
      screen.getByRole("menuitem", { name: "Export this entry" }),
    );
    await waitFor(() =>
      expect(mockedStartUserExport).toHaveBeenCalledWith("audit-csv", {
        org_id: "org-a",
        event_ids: [EVENT.id],
        sort_by: undefined,
        sort_dir: undefined,
      }),
    );
    await waitFor(() => expect(mockedDownloadUserExport).toHaveBeenCalled());
  });

  it("keeps a failed export's selection and shows an intentional error", async () => {
    const user = userEvent.setup();
    mockedStartUserExport.mockRejectedValueOnce(
      new Error("private database details"),
    );
    render(<MyActivitySettingsPage />);
    await user.click(
      await screen.findByRole("checkbox", { name: `Select ${EVENT.title}` }),
    );
    await user.click(
      screen.getByRole("button", { name: "Actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your export could not be created. Please try again.",
    );
    expect(
      screen.queryByText("private database details"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: `Select ${EVENT.title}` }),
    ).toBeChecked();
  });

  it("applies custom table dates only on Apply and inherits them when exporting", async () => {
    const user = userEvent.setup();
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);

    await user.click(
      screen.getByRole("button", { name: /^Select date range:/ }),
    );
    const popover = screen.getByRole("dialog", {
      name: "Filter by date range",
    });
    expect(popover).toHaveClass("liquid-glass-float");
    expect(popover).toHaveAttribute("data-align", "start");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Date range: Last 30 days" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Custom range" }));
    const applyButton = screen.getByRole("button", { name: "Apply" });
    expect(applyButton).toBeDisabled();

    const callsBeforeSelection = mockedGetAuditHistory.mock.calls.length;
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-05-20" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-06-14" },
    });
    expect(applyButton).toBeEnabled();
    expect(mockedGetAuditHistory).toHaveBeenCalledTimes(callsBeforeSelection);

    await user.click(applyButton);
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          from: "2026-05-20",
          to: "2026-06-14",
          page: 1,
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "My Activity actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(screen.getByLabelText("From")).toHaveValue("2026-05-20");
    expect(screen.getByLabelText("To")).toHaveValue("2026-06-14");
    expect(
      screen.queryByRole("button", { name: "Apply" }),
    ).not.toBeInTheDocument();
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() =>
      expect(mockedStartUserExport).toHaveBeenCalledWith(
        "audit-csv",
        expect.objectContaining({ from: "2026-05-20", to: "2026-06-14" }),
      ),
    );
    await waitFor(() =>
      expect(mockedDownloadUserExport).toHaveBeenCalledWith("export-1"),
    );
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:history");
  });

  it.each([
    ["Today", "2026-06-15", "2026-06-15"],
    ["Last 7 days", "2026-06-09", "2026-06-15"],
    ["Last 30 days", "2026-05-17", "2026-06-15"],
    ["This month", "2026-06-01", "2026-06-15"],
    ["Last month", "2026-05-01", "2026-05-31"],
  ])(
    "applies the %s preset immediately and exports the same inclusive dates",
    async (label, from, to) => {
      const user = userEvent.setup();
      render(<MyActivitySettingsPage />);
      await screen.findByText(EVENT.title!);
      await user.click(
        screen.getByRole("button", { name: /^Select date range:/ }),
      );
      await user.click(screen.getByRole("button", { name: /^Date range:/ }));
      await user.click(screen.getByRole("menuitem", { name: label }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ from, to, page: 1 }),
        expect.any(AbortSignal),
      );
      await user.click(
        screen.getByRole("button", { name: "My Activity actions" }),
      );
      await user.click(screen.getByRole("menuitem", { name: "Export" }));
      expect(
        screen.getByRole("button", { name: `Date range: ${label}` }),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Export CSV" }));
      await waitFor(() =>
        expect(mockedStartUserExport).toHaveBeenCalledWith(
          "audit-csv",
          expect.objectContaining({ from, to }),
        ),
      );
    },
  );

  it.each([
    [new Date(2026, 0, 1, 12), "2025-12-01", "2025-12-31"],
    [new Date(2024, 2, 31, 12), "2024-02-01", "2024-02-29"],
  ])(
    "exports Last month across year and leap-year boundaries (%s)",
    async (today, from, to) => {
      vi.setSystemTime(today);
      const user = userEvent.setup();
      render(<MyActivitySettingsPage />);
      await screen.findByText(EVENT.title!);
      await user.click(
        screen.getByRole("button", { name: "My Activity actions" }),
      );
      await user.click(screen.getByRole("menuitem", { name: "Export" }));
      await user.click(screen.getByRole("button", { name: /^Date range:/ }));
      await user.click(screen.getByRole("menuitem", { name: "Last month" }));
      await user.click(screen.getByRole("button", { name: "Export CSV" }));
      await waitFor(() =>
        expect(mockedStartUserExport).toHaveBeenCalledWith(
          "audit-csv",
          expect.objectContaining({ from, to }),
        ),
      );
    },
  );

  it("polls the export job until it finishes before downloading", async () => {
    const user = userEvent.setup();
    mockedGetUserExportStatus
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({
        status: "done",
        filename: "my-activity.csv",
      });

    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    await user.click(
      screen.getByRole("button", { name: "My Activity actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() =>
      expect(mockedGetUserExportStatus).toHaveBeenCalledTimes(2),
    );
    // The download starts after the second status call resolves, a tick
    // later than the call itself; asserting it synchronously raced on CI.
    await waitFor(() =>
      expect(mockedDownloadUserExport).toHaveBeenCalledWith("export-1"),
    );
  });

  it("keeps the export modal open with a retryable error when the job fails", async () => {
    const user = userEvent.setup();
    mockedGetUserExportStatus.mockResolvedValue({ status: "failed" });

    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    await user.click(
      screen.getByRole("button", { name: "My Activity actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your activity could not be exported.",
    );
    expect(
      screen.getByText(
        "Your activity could not be exported. Please try again.",
      ),
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

    render(<MyActivitySettingsPage />);

    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(screen.getByText("No activity yet").parentElement).toHaveClass(
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

    render(<AuditHistory orgId="org-a" />);

    expect(await screen.findByText("lawyer@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Alex Lawyer")).toBeNull();
  });

  it("automatically appends the next page once and stops at the end", async () => {
    const user = userEvent.setup();
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
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    await user.click(
      screen.getByRole("checkbox", { name: "Select all loaded entries" }),
    );

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
      screen.getByRole("checkbox", { name: `Select ${EVENT.title}` }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Second event" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select all loaded entries" }),
    ).toBePartiallyChecked();
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
    render(<MyActivitySettingsPage />);
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
    render(<MyActivitySettingsPage />);
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
    render(<MyActivitySettingsPage />);
    const row = await screen.findByRole("button", {
      name: `View details for ${EVENT.title}`,
    });
    expect(
      screen.queryByRole("link", { name: EVENT.title! }),
    ).not.toBeInTheDocument();
    await user.click(row);
    const modal = within(screen.getByRole("dialog", { name: "Event details" }));
    expect(modal.queryByText(email)).not.toBeInTheDocument();
    expect(
      modal.getByRole("heading", { name: "Document edited" }),
    ).toBeVisible();
    const metadata = modal.getByText(/"workflow_id": "workflow-123"/);
    expect(metadata).not.toBeVisible();
    await user.click(modal.getByText("Technical details"));
    expect(metadata).toBeVisible();
    expect(modal.getByText("gpt-5")).toBeInTheDocument();
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
    render(<MyActivitySettingsPage />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "View details for Document edited",
      }),
    );
    const modal = within(screen.getByRole("dialog", { name: "Event details" }));
    expect(
      modal.getByRole("heading", { name: "Document edited" }),
    ).toBeInTheDocument();
    expect(modal.queryByRole("link")).not.toBeInTheDocument();
    expect(modal.queryByText("Additional details")).not.toBeInTheDocument();
  });

  it("exports the modal's chosen period without changing the table dates or dropping filters", async () => {
    const user = userEvent.setup();
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    await user.click(screen.getByRole("button", { name: "Filter by status" }));
    await user.click(screen.getByRole("menuitem", { name: "Completed" }));
    await user.click(
      screen.getByRole("button", { name: "Sort by affected" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Ascending" }));
    await user.click(
      screen.getByRole("button", { name: "Search my activity…" }),
    );
    await user.type(
      screen.getByPlaceholderText("Search my activity…"),
      "agreement",
    );
    await waitFor(() =>
      expect(mockedGetAuditHistory).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: "agreement" }),
        expect.any(AbortSignal),
      ),
    );
    const tableCalls = mockedGetAuditHistory.mock.calls.length;
    await user.click(
      screen.getByRole("button", { name: "My Activity actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    const modal = within(
      screen.getByRole("dialog", { name: "Export My Activity" }),
    );
    await user.click(modal.getByRole("button", { name: /^Date range:/ }));
    await user.click(screen.getByRole("menuitem", { name: "Custom range" }));
    fireEvent.change(modal.getByLabelText("From"), {
      target: { value: "2026-05-17" },
    });
    fireEvent.change(modal.getByLabelText("To"), {
      target: { value: "2026-06-14" },
    });
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    expect(mockedGetAuditHistory).toHaveBeenCalledTimes(tableCalls);
    expect(modal.queryByText(/\(inclusive\)/)).not.toBeInTheDocument();
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

  it.each([
    ["From", "", "Choose a start and end date."],
    ["To", "2026-05-01", "End date must be on or after start date."],
    ["To", "2026-06-16", "Dates cannot be in the future."],
    ["From", "10000-01-01", "Enter a valid date in YYYY-MM-DD format."],
    ["From", "2026-02-30", "Enter a valid date in YYYY-MM-DD format."],
  ])(
    "blocks invalid custom dates (%s: %s) until corrected",
    async (field, value, message) => {
      const user = userEvent.setup();
      render(<MyActivitySettingsPage />);
      await screen.findByText(EVENT.title!);
      await user.click(
        screen.getByRole("button", { name: "My Activity actions" }),
      );
      await user.click(screen.getByRole("menuitem", { name: "Export" }));
      await user.click(screen.getByRole("button", { name: /^Date range:/ }));
      await user.click(screen.getByRole("menuitem", { name: "Custom range" }));
      fireEvent.change(screen.getByLabelText(field), { target: { value } });
      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(screen.getByLabelText(field)).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      const exportButton = screen.getByRole("button", { name: "Export CSV" });
      expect(exportButton).toBeDisabled();
      await user.click(exportButton);
      expect(mockedStartUserExport).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("From"), {
        target: { value: "2026-06-15" },
      });
      fireEvent.change(screen.getByLabelText("To"), {
        target: { value: "2026-06-15" },
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(exportButton).toBeEnabled();
      await user.click(exportButton);
      await waitFor(() =>
        expect(mockedStartUserExport).toHaveBeenCalledWith(
          "audit-csv",
          expect.objectContaining({ from: "2026-06-15", to: "2026-06-15" }),
        ),
      );
    },
  );

  it("opens liquid-glass calendars with keyboard selection and bounded dates", async () => {
    const user = userEvent.setup();
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    await user.click(
      screen.getByRole("button", { name: "My Activity actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: /^Date range:/ }));
    await user.click(screen.getByRole("menuitem", { name: "Custom range" }));
    await user.click(screen.getByRole("button", { name: "From calendar" }));
    const fromCalendar = screen.getByRole("dialog", { name: "From calendar" });
    expect(fromCalendar).toHaveClass(
      "theme-dropdown-surface",
      "liquid-glass-float",
    );
    expect(
      fromCalendar.querySelector('[data-day="2026-05-17"] button'),
    ).toHaveFocus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(
      screen.queryByRole("dialog", { name: "From calendar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("From")).toHaveValue("2026-05-18");
    expect(screen.getByRole("button", { name: "From calendar" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "To calendar" }));
    const toCalendar = screen.getByRole("dialog", { name: "To calendar" });
    expect(
      toCalendar.querySelector('[data-day="2026-06-16"] button'),
    ).toBeDisabled();
    await user.click(
      within(toCalendar).getByRole("button", {
        name: "Go to the Previous Month",
      }),
    );
    expect(
      toCalendar.querySelector('[data-day="2026-05-17"] button'),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "Export My Activity" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "To calendar" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/\(inclusive\)/)).not.toBeInTheDocument();
  });

  it("uses compact flat date controls and separate calendar month and year menus", async () => {
    const user = userEvent.setup();
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    await user.click(
      screen.getByRole("button", { name: /^Select date range:/ }),
    );
    expect(
      screen.getByRole("dialog", { name: "Filter by date range" }),
    ).toHaveClass("w-80");
    const preset = screen.getByRole("button", { name: /^Date range:/ });
    expect(preset).toHaveClass("h-8", "bg-app-surface-active");
    expect(preset).not.toHaveClass("liquid-glass-subtle", "liquid-glass-hover");
    await user.click(preset);
    await user.click(screen.getByRole("menuitem", { name: "Custom range" }));
    expect(screen.getByLabelText("From")).toHaveClass("h-8", "text-xs");
    expect(screen.getByLabelText("To")).toHaveClass("h-8", "text-xs");
    await user.click(screen.getByRole("button", { name: "From calendar" }));
    await user.click(screen.getByRole("button", { name: "Month: May" }));
    await user.click(
      screen.getByRole("menuitem", { name: "February" }),
    );
    expect(
      screen.getByRole("button", { name: "Month: February" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Year: 2026" }));
    await user.click(
      screen.getByRole("menuitem", { name: "2024" }),
    );
    const calendar = screen.getByRole("dialog", { name: "From calendar" });
    await user.click(calendar.querySelector('[data-day="2024-02-29"] button')!);
    expect(screen.getByLabelText("From")).toHaveValue("2024-02-29");
    expect(
      screen.getByRole("dialog", { name: "Filter by date range" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "From calendar" }),
    ).not.toBeInTheDocument();
  });

  it("does not apply an invalid or dismissed custom table range", async () => {
    const user = userEvent.setup();
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    const tableCalls = mockedGetAuditHistory.mock.calls.length;
    await user.click(
      screen.getByRole("button", { name: /^Select date range:/ }),
    );
    await user.click(screen.getByRole("button", { name: /^Date range:/ }));
    await user.click(screen.getByRole("menuitem", { name: "Custom range" }));
    await user.click(screen.getByRole("button", { name: "From calendar" }));
    expect(
      screen.getByRole("dialog", { name: "From calendar" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "From calendar" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Filter by date range" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockedGetAuditHistory).toHaveBeenCalledTimes(tableCalls);
    await user.click(
      screen.getByRole("button", { name: /^Select date range:/ }),
    );
    expect(
      screen.getByRole("button", { name: "Date range: Last 30 days" }),
    ).toBeInTheDocument();
  });

  it("uses the same presets for organization audit exports and disables dates while exporting", async () => {
    const user = userEvent.setup();
    let finishExport!: (value: { export_id: string }) => void;
    mockedStartUserExport.mockReturnValue(
      new Promise((resolve) => {
        finishExport = resolve;
      }),
    );
    render(<AuditHistory orgId="org-a" />);
    await screen.findByText(EVENT.title!);
    await user.click(screen.getByRole("button", { name: "Audit log actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(
      screen.getByRole("dialog", { name: "Export audit log" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Date range:/ }));
    await user.click(screen.getByRole("menuitem", { name: "Last 7 days" }));
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(mockedStartUserExport).toHaveBeenCalledWith(
      "audit-csv",
      expect.objectContaining({
        org_id: "org-a",
        from: "2026-06-09",
        to: "2026-06-15",
      }),
    );
    expect(screen.getByRole("button", { name: /^Date range:/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();
    await act(async () => finishExport({ export_id: "export-1" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("cancels export without creating a job and resets the draft when reopened", async () => {
    const user = userEvent.setup();
    render(<MyActivitySettingsPage />);
    await screen.findByText(EVENT.title!);
    await user.click(
      screen.getByRole("button", { name: "My Activity actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: /^Date range:/ }));
    await user.click(screen.getByRole("menuitem", { name: "Custom range" }));
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-05-20" },
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockedStartUserExport).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "My Activity actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Export" }));
    expect(
      screen.getByRole("button", { name: "Date range: Last 30 days" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Date range:/ }));
    await user.click(screen.getByRole("menuitem", { name: "Custom range" }));
    expect(screen.getByLabelText("From")).toHaveValue("2026-05-17");
    expect(screen.getByLabelText("To")).toHaveValue("2026-06-15");
  });
});

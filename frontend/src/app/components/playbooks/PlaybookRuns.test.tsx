import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybookRun } from "@/app/lib/mikeApi";
import { PlaybookRuns } from "./PlaybookRuns";
import {
  subscribePlaybookRunChanges,
  useViewedPlaybookRun,
} from "@/app/lib/playbookRunActivity";

const api = vi.hoisted(() => ({
  listPlaybookRuns: vi.fn(),
  resolveDocumentEdit: vi.fn(),
}));
const viewer = vi.hoisted(() => ({ docx: vi.fn() }));
// The real viewer lazy-loads a Word renderer that jsdom cannot run.
vi.mock("@/app/components/shared/views/DocxView", () => ({
  DocxView: (props: { documentId: string; refetchKey?: number }) => {
    viewer.docx(props);
    return (
      <div
        role="document"
        aria-label={`Document ${props.documentId}, revision ${props.refetchKey}`}
      />
    );
  },
}));
vi.mock("@/app/lib/mikeApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/mikeApi")>()),
  ...api,
}));

// Showing a run's results, not the new-run form.
const resultsProps = () => ({
  canRun: true,
  composing: false,
  newRun: null,
  onNewRun: vi.fn(),
  onCloseNewRun: vi.fn(),
});

function run(overrides: Partial<PlaybookRun> = {}): PlaybookRun {
  return {
    id: "run-1",
    playbookId: "pb",
    model: "claude-opus-5-5",
    documentName: "Supply agreement.docx",
    reviewMode: "strict",
    status: "completed",
    summary: "One uncapped indemnity.",
    findings: [
      {
        id: "f-1",
        topicId: null,
        ruleId: "cap",
        ruleName: "Liability cap",
        status: "unacceptable",
        quote: "Liability is unlimited.",
        location: "Clause 9",
        analysis: "The cap is missing.",
        suggestedText: "Liability is capped at fees paid.",
      },
      {
        id: "f-2",
        topicId: null,
        ruleId: "law",
        ruleName: "Governing law",
        status: "needs_review",
        quote: "",
        location: "",
        analysis: "Unclear.",
        suggestedText: "",
      },
    ],
    error: null,
    startedAt: "2026-10-17T09:00:00.000Z",
    completedAt: "2026-10-17T09:01:00.000Z",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("playbook runs", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a review still running on the server, and its findings once it finishes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const changed = vi.fn();
    const unsubscribe = subscribePlaybookRunChanges(changed);
    const viewed = renderHook(() => useViewedPlaybookRun());
    const running = run({ status: "running", summary: null, findings: [] });
    api.listPlaybookRuns.mockResolvedValue([running]);
    const { unmount } = render(
      <PlaybookRuns playbookId="pb" latestRun={null} {...resultsProps()} />,
    );

    const list = screen.getByRole("region", { name: "Your runs" });
    expect(
      await within(list).findByRole("button", {
        name: "Supply agreement.docx, running",
      }),
    ).toBeVisible();
    const results = screen.getByRole("region", { name: "Run results" });
    expect(within(results).getByRole("status")).toHaveTextContent(
      "Reviewing Supply agreement.docx…",
    );
    // History is told which run is on screen, so it shows no tick for it.
    await waitFor(() => expect(viewed.result.current).toBe("run-1"));

    api.listPlaybookRuns.mockResolvedValue([run()]);
    await act(() => vi.advanceTimersByTimeAsync(3000));

    expect(await within(results).findByText("Liability cap")).toBeVisible();
    expect(
      within(list).getByRole("button", { name: "Supply agreement.docx" }),
    ).toBeVisible();
    // Other lists, such as History, are told it has finished.
    expect(changed).toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(viewed.result.current).toBeNull());
    unsubscribe();
  });

  it("can show only the issues of a full review, without losing the rest", async () => {
    const full = run();
    api.listPlaybookRuns.mockResolvedValue([
      {
        ...full,
        findings: [
          ...full.findings,
          { ...full.findings[1], id: "f-3", ruleId: "term", ruleName: "Term", status: "acceptable" as const },
        ],
      },
    ]);
    render(<PlaybookRuns playbookId="pb" latestRun={null} {...resultsProps()} />);
    const results = await screen.findByRole("region", { name: "Run results" });
    expect(await within(results).findByRole("region", { name: /Acceptable/ })).toBeVisible();

    const show = within(results).getByRole("group", { name: "Findings to show" });
    await userEvent.click(within(show).getByRole("button", { name: "Issues only" }));
    expect(within(results).queryByRole("region", { name: /Acceptable/ })).toBeNull();
    expect(within(results).getByRole("region", { name: /Issues/ })).toBeVisible();
    expect(within(results).getByRole("region", { name: /Needs review/ })).toBeVisible();

    await userEvent.click(within(show).getByRole("button", { name: "All findings" }));
    expect(within(results).getByRole("region", { name: /Acceptable/ })).toBeVisible();
  });

  it("names an issues-only run's scope and offers no filter for it", async () => {
    api.listPlaybookRuns.mockResolvedValue([run({ reviewScope: "issues" })]);
    render(<PlaybookRuns playbookId="pb" latestRun={null} {...resultsProps()} />);
    const results = await screen.findByRole("region", { name: "Run results" });
    const details = await within(results).findByRole("region", { name: "Run details" });
    expect(within(details).getByText("Issues only")).toBeVisible();
    expect(within(results).queryByRole("group", { name: "Findings to show" })).toBeNull();
  });

  it("follows a run asked for after it opened", async () => {
    api.listPlaybookRuns.mockResolvedValue([
      run({ id: "new", documentName: "New.docx" }),
      run({ id: "old", documentName: "Old.docx" }),
    ]);
    const props = resultsProps();
    const { rerender } = render(
      <PlaybookRuns playbookId="pb" latestRun={null} {...props} />,
    );
    const list = screen.getByRole("region", { name: "Your runs" });
    expect(
      await within(list).findByRole("button", { name: "New.docx" }),
    ).toHaveAttribute("aria-pressed", "true");

    rerender(
      <PlaybookRuns
        playbookId="pb"
        latestRun={null}
        {...props}
        initialRunId="old"
      />,
    );
    expect(within(list).getByRole("button", { name: "Old.docx" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens the hidden document when a tracked change asks to be viewed", async () => {
    const reviewed = run();
    api.listPlaybookRuns.mockResolvedValue([
      {
        ...reviewed,
        documentId: "doc-1",
        editedVersionId: "v2",
        findings: [
          {
            ...reviewed.findings[0],
            edit: {
              kind: "edit" as const,
              edit_id: "e1",
              document_id: "doc-1",
              version_id: "v2",
              version_number: 2,
              change_id: "c1",
              deleted_text: "unlimited",
              inserted_text: "capped at fees paid",
              context_before: "Liability is ",
              context_after: ".",
              status: "pending" as const,
            },
          },
        ],
      },
    ]);
    render(
      <PlaybookRuns playbookId="pb" latestRun={null} {...resultsProps()} />,
    );

    const issues = await screen.findByRole("region", { name: /Issues/ });
    expect(
      screen.queryByRole("region", { name: "Reviewed document" }),
    ).toBeNull();
    await userEvent.click(within(issues).getByRole("button", { name: "View" }));
    expect(
      screen.getByRole("region", { name: "Reviewed document" }),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Close document" }),
    );
    expect(
      screen.queryByRole("region", { name: "Reviewed document" }),
    ).toBeNull();
  });

  it("shows a reviewed Word document beside its results and decides its tracked changes", async () => {
    const edit = {
      kind: "edit" as const,
      edit_id: "e1",
      document_id: "doc-1",
      version_id: "v2",
      version_number: 2,
      change_id: "c1",
      deleted_text: "unlimited",
      inserted_text: "capped at fees paid",
      context_before: "Liability is ",
      context_after: ".",
      status: "pending" as const,
    };
    const reviewed = run();
    api.listPlaybookRuns.mockResolvedValue([
      {
        ...reviewed,
        documentId: "doc-1",
        editedVersionId: "v2",
        findings: [{ ...reviewed.findings[0], edit }],
      },
    ]);
    api.resolveDocumentEdit.mockResolvedValue({
      ok: true,
      status: "accepted",
      version_id: "v3",
      download_url: null,
    });
    render(
      <PlaybookRuns playbookId="pb" latestRun={null} {...resultsProps()} />,
    );

    // The document stays hidden until asked for, then opens to the right of
    // the results.
    const results = await screen.findByRole("region", { name: "Run results" });
    const view = await within(results).findByRole("button", {
      name: "View document",
    });
    expect(view).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.queryByRole("region", { name: "Reviewed document" }),
    ).toBeNull();
    expect(
      within(results).getByRole("heading", { level: 2, name: "Run results" }),
    ).toBeVisible();
    await userEvent.click(view);
    expect(view).toHaveAttribute("aria-pressed", "true");
    const pane = screen.getByRole("region", { name: "Reviewed document" });
    expect(
      screen.getByRole("separator", { name: "Resize runs panel" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: "Resize document panel" }),
    ).toBeInTheDocument();
    expect(
      results.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(pane).getByRole("document", {
        name: "Document doc-1, revision 0",
      }),
    ).toBeInTheDocument();
    // The document pane names the document; the heading stays the same.
    expect(
      within(pane).getByRole("heading", {
        level: 2,
        name: "Supply agreement.docx",
      }),
    ).toBeVisible();
    expect(
      within(results).getByRole("heading", { level: 2, name: "Run results" }),
    ).toBeVisible();
    // A change in the document is decided from an edit card.
    const issues = screen.getByRole("region", { name: /Issues/ });
    expect(within(issues).getByText("Recommended change")).toBeVisible();
    expect(within(issues).queryByText("Recommended changes")).toBeNull();

    await userEvent.click(
      within(issues).getByRole("button", { name: "Accept" }),
    );

    expect(api.resolveDocumentEdit).toHaveBeenCalledWith(
      "doc-1",
      "e1",
      "accept",
    );
    // The document reloads to show the change accepted.
    expect(
      await within(pane).findByRole("document", {
        name: "Document doc-1, revision 1",
      }),
    ).toBeInTheDocument();
  });

  it("lists past runs with their outcome and shows the selected run's findings", async () => {
    api.listPlaybookRuns.mockResolvedValue([
      run(),
      run({
        id: "run-0",
        documentName: "Old NDA.pdf",
        summary: "Nothing to change.",
        findings: [],
        startedAt: "2026-10-16T09:00:00.000Z",
      }),
    ]);
    render(
      <PlaybookRuns playbookId="pb" latestRun={null} {...resultsProps()} />,
    );
    const list = screen.getByRole("region", { name: "Your runs" });
    const latest = await within(list).findByRole("button", {
      name: /Supply agreement\.docx/,
    });
    expect(latest).toHaveAttribute("aria-pressed", "true");
    // One line per run: the document alone, without the outcome.
    expect(latest).toHaveTextContent(/^Supply agreement\.docx$/);
    expect(api.listPlaybookRuns).toHaveBeenCalledWith("pb");
    const results = screen.getByRole("region", { name: "Run results" });
    // The heading names the pane; the selected row names the document.
    expect(
      within(results).getByRole("heading", { level: 2, name: "Run results" }),
    ).toBeVisible();
    // What was reviewed, how, and when, before the findings.
    const details = within(results).getByRole("region", { name: "Run details" });
    for (const label of ["Document", "Model", "Scope", "Posture", "Started"])
      expect(within(details).getByText(label)).toBeVisible();
    expect(within(details).getByText("Supply agreement.docx")).toBeVisible();
    expect(details.querySelector("time")).toHaveAttribute(
      "datetime",
      expect.stringMatching(/^2026-/),
    );
    // The header keeps only the heading and the document's button.
    expect(
      results.querySelector("h2")?.parentElement?.querySelector("time"),
    ).toBeNull();
    // Findings are grouped by urgency, each in its own card.
    const issues = within(results).getByRole("region", { name: /Issues/ });
    expect(within(issues).getByText("Liability cap")).toBeVisible();
    expect(within(issues).getByText("Unacceptable")).toBeVisible();
    expect(within(issues).getByText("Clause 9")).toBeVisible();
    // Each part of a finding says what it is.
    for (const label of ["Where", "Assessment", "Recommended changes"])
      expect(within(issues).getByText(label)).toBeVisible();
    // The recommendation is a redline of the contract language.
    const removed = issues.querySelector("del");
    const added = issues.querySelector("ins");
    expect(removed).toHaveTextContent("Removed: unlimited");
    expect(added).toHaveTextContent("Added: capped at fees paid");
    expect(within(issues).queryByText("Contract language")).toBeNull();
    const toReview = within(results).getByRole("region", {
      name: /Needs review/,
    });
    expect(within(toReview).getByText("Governing law")).toBeVisible();
    expect(
      within(results).queryByRole("region", { name: /Acceptable/ }),
    ).toBeNull();

    await userEvent.click(
      within(list).getByRole("button", { name: /Old NDA\.pdf/ }),
    );

    expect(within(results).getByText("Nothing to change.")).toBeVisible();
    expect(within(results).getByText("No findings.")).toBeVisible();
  });

  it("selects a run finished on the page before the history loads", async () => {
    api.listPlaybookRuns.mockResolvedValue([
      run({ id: "run-0", documentName: "Older.docx" }),
    ]);
    render(
      <PlaybookRuns
        playbookId="pb"
        latestRun={run({ id: "run-new", documentName: "Fresh.docx" })}
        {...resultsProps()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /Fresh\.docx/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Older\.docx/ })).toBeVisible();
  });

  it("refreshes history when a batch completes while the Runs tab is already open", async () => {
    api.listPlaybookRuns.mockResolvedValue([]);
    const { rerender } = render(
      <PlaybookRuns playbookId="pb" latestRun={null} {...resultsProps()} />,
    );
    await screen.findByText("None yet.");
    const first = run({ id: "batch-1", documentName: "First.txt" });
    const second = run({ id: "batch-2", documentName: "Second.txt" });
    api.listPlaybookRuns.mockResolvedValue([second, first]);
    rerender(
      <PlaybookRuns playbookId="pb" latestRun={second} {...resultsProps()} />,
    );
    const list = screen.getByRole("region", { name: "Your runs" });
    expect(
      await within(list).findByRole("button", { name: "First.txt" }),
    ).toBeVisible();
    expect(
      within(list).getByRole("button", { name: "Second.txt" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(api.listPlaybookRuns).toHaveBeenCalledTimes(2);
  });

  it("offers a new run when there are none yet, and from the list header", async () => {
    api.listPlaybookRuns.mockResolvedValue([]);
    const props = resultsProps();
    render(<PlaybookRuns playbookId="pb" latestRun={null} {...props} />);

    const results = screen.getByRole("region", { name: "Run results" });
    await userEvent.click(
      await within(results).findByRole("button", { name: "New run" }),
    );
    const list = screen.getByRole("region", { name: "Your runs" });
    await userEvent.click(
      within(list).getByRole("button", { name: "New run" }),
    );

    expect(props.onNewRun).toHaveBeenCalledTimes(2);
    expect(screen.getByText("None yet.")).toBeVisible();
  });

  it("shows the new-run form in place of the results, and leaves it for a chosen run", async () => {
    api.listPlaybookRuns.mockResolvedValue([run()]);
    const props = { ...resultsProps(), composing: true };
    render(
      <PlaybookRuns
        playbookId="pb"
        latestRun={null}
        {...props}
        newRun={<section aria-label="New run form" />}
      />,
    );

    const list = screen.getByRole("region", { name: "Your runs" });
    const row = await within(list).findByRole("button", {
      name: /Supply agreement\.docx/,
    });
    expect(screen.getByRole("region", { name: "New run form" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Run results" })).toBeNull();
    // While the form is open, no run is shown as selected.
    expect(row).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(row);
    expect(props.onCloseNewRun).toHaveBeenCalled();
  });

  it("shows a failed run's error and retries a failed load", async () => {
    api.listPlaybookRuns
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([
        run({ error: "The model timed out.", findings: [] }),
      ]);
    render(
      <PlaybookRuns playbookId="pb" latestRun={null} {...resultsProps()} />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Try again" }),
    );

    expect(
      await screen.findByRole("button", { name: /Supply agreement/ }),
    ).toBeVisible();
    expect(screen.getByText("The model timed out.")).toBeVisible();
  });
});

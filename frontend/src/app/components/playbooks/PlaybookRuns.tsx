"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Eye, Loader2, Plus, X } from "lucide-react";
import { EditCard } from "@/app/components/assistant/EditCard";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import type { EditAnnotation } from "@/app/components/shared/types";
import { docxRevisionElements } from "@/app/components/shared/views/docxRevisionElements";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { PdfView } from "@/app/components/shared/views/PdfView";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import {
  EDITOR_SURFACE_CLASS,
  LIQUID_GLASS_FLAT_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
  listPlaybookRuns,
  type PlaybookFinding,
  type PlaybookRun,
} from "@/app/lib/mikeApi";
import { describeError } from "@/app/lib/userFacingError";
import {
  notifyPlaybookRunsChanged,
  setViewedPlaybookRun,
} from "@/app/lib/playbookRunActivity";
import { diffWords } from "@/app/lib/wordDiff";
import { modelDisplayName } from "@mike/client";
import { PillButtonUI, TextButtonUI, TextSlabUI } from "@mike/ui";
import { ModalSegmentedToggle } from "@/app/components/modals/ModalSegmentedToggle";
import { PlaybookPanels } from "./PlaybookPanels";
import {
  PLAYBOOK_PANE_BODY_CLASS,
  PLAYBOOK_PANE_EMPTY_CLASS,
  PLAYBOOK_PANE_HEADER_CLASS,
  PLAYBOOK_PANE_TITLE_CLASS,
  PLAYBOOK_SIDE_HEADER_CLASS,
  PLAYBOOK_SIDE_LIST_CLASS,
  PLAYBOOK_SIDE_TITLE_CLASS,
} from "./playbookPaneStyles";

const STATUS_LABEL: Record<string, string> = {
  unacceptable: "Unacceptable",
  missing_required: "Missing",
  needs_review: "Needs review",
  acceptable: "Acceptable",
  not_applicable: "Not applicable",
  outside_scope: "Outside scope",
};

const STATUS_TONE: Record<string, string> = {
  unacceptable: "text-red-600",
  missing_required: "text-red-600",
  needs_review: "text-amber-700",
  acceptable: "text-green-700",
  not_applicable: "text-gray-500",
  outside_scope: "text-gray-500",
};

// Findings grouped from most to least urgent; the dots match the playbook's
// position colours.
const FINDING_GROUPS: {
  title: string;
  dot: string;
  statuses: PlaybookFinding["status"][];
}[] = [
  {
    title: "Issues",
    dot: "bg-red-500",
    statuses: ["unacceptable", "missing_required"],
  },
  { title: "Needs review", dot: "bg-amber-500", statuses: ["needs_review"] },
  { title: "Acceptable", dot: "bg-emerald-500", statuses: ["acceptable"] },
  {
    title: "Not applicable",
    dot: "bg-gray-400",
    statuses: ["not_applicable", "outside_scope"],
  },
];

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function runTitle(run: PlaybookRun) {
  return run.documentName || "Untitled document";
}

/** "2 issues · 1 to review", or the run's state when it has no findings. */
export function runOutcome(run: PlaybookRun) {
  if (run.error || run.status === "failed") return "Failed";
  if (run.status !== "completed") return "In progress";
  const issues = run.findings.filter(
    (finding) =>
      finding.status === "unacceptable" ||
      finding.status === "missing_required",
  ).length;
  const toReview = run.findings.filter(
    (finding) => finding.status === "needs_review",
  ).length;
  const parts = [
    issues ? `${issues} ${issues === 1 ? "issue" : "issues"}` : null,
    toReview ? `${toReview} to review` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No issues";
}

/**
 * Past reviews of one playbook: the caller's runs on the left, newest first,
 * and the selected run's summary and findings in the main pane, or the form
 * for a new run. The reviewed document opens to the right of the findings on
 * request. A run finished on this page arrives as `latestRun` and is
 * selected.
 */
export function PlaybookRuns({
  playbookId,
  latestRun,
  initialRunId = null,
  canRun,
  composing,
  newRun,
  onNewRun,
  onCloseNewRun,
}: {
  playbookId: string;
  latestRun: PlaybookRun | null;
  /** A run to open first, such as one chosen from the list of all runs. */
  initialRunId?: string | null;
  canRun: boolean;
  /** Shows `newRun` in the main pane in place of a run's results. */
  composing: boolean;
  newRun: ReactNode;
  onNewRun: () => void;
  /** Choosing a run leaves the new-run form; what it holds is kept. */
  onCloseNewRun: () => void;
}) {
  const [runs, setRuns] = useState<PlaybookRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    latestRun?.id ?? initialRunId,
  );
  // A run finished while this tab is open becomes the selection.
  const [seenLatestId, setSeenLatestId] = useState(latestRun?.id ?? null);
  if ((latestRun?.id ?? null) !== seenLatestId) {
    setSeenLatestId(latestRun?.id ?? null);
    if (latestRun) setSelectedId(latestRun.id);
  }
  // So does a run asked for later, such as one chosen in History.
  const [seenInitialId, setSeenInitialId] = useState(initialRunId);
  if (initialRunId !== seenInitialId) {
    setSeenInitialId(initialRunId);
    if (initialRunId) setSelectedId(initialRunId);
  }

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    listPlaybookRuns(playbookId).then(
      (items) => {
        if (!current) return;
        setRuns(items);
        setError(null);
      },
      (err) => {
        if (!current) return;
        setError(describeError(err, { action: "load the runs" }).message);
        // A failed poll keeps the runs already loaded, so polling goes on.
        setRuns((existing) => existing ?? []);
      },
    );
    return () => {
      current = false;
    };
  }, [playbookId, attempt, latestRun?.id]);

  const all =
    runs === null
      ? null
      : latestRun && !runs.some((run) => run.id === latestRun.id)
        ? [latestRun, ...runs]
        : runs;
  const selected =
    all?.find((run) => run.id === selectedId) ?? all?.[0] ?? null;

  // Reviews run on the server: reload the list while any is running, and
  // tell other lists, such as History, when one has finished.
  const runningIds = (all ?? [])
    .filter((run) => run.status === "running")
    .map((run) => run.id)
    .join(",");
  useEffect(() => {
    if (!runningIds) return;
    const timer = setTimeout(() => setAttempt((count) => count + 1), 3000);
    return () => clearTimeout(timer);
    // `attempt` re-arms the poll after one that failed and changed nothing.
  }, [runningIds, runs, attempt]);
  const runningBefore = useRef(new Set<string>());
  useEffect(() => {
    if (!runs) return;
    const running = new Set(
      runs.filter((run) => run.status === "running").map((run) => run.id),
    );
    if ([...runningBefore.current].some((id) => !running.has(id)))
      notifyPlaybookRunsChanged();
    runningBefore.current = running;
  }, [runs]);

  // The run whose results are on screen, so History does not mark it.
  const viewedId = !composing && selected ? selected.id : null;
  useEffect(() => setViewedPlaybookRun(viewedId), [viewedId]);
  useEffect(() => () => setViewedPlaybookRun(null), []);
  const documentPane = useRef<HTMLElement>(null);
  // The document opens only when asked for, and stays open between runs.
  const [documentOpen, setDocumentOpen] = useState(false);
  const showDocument = documentOpen && !!selected?.documentId;
  const [documentRevision, setDocumentRevision] = useState(0);
  // The findings view, kept while moving between runs.
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [resolved, setResolved] = useState<
    Record<string, "accepted" | "rejected">
  >({});

  /** Scrolls the reviewed document to a tracked change, if it is shown. */
  function scrollToEdit(annotation: EditAnnotation) {
    const container = documentPane.current?.querySelector(
      ".docx-view-container",
    );
    if (!container) return false;
    const [target] = [
      ...docxRevisionElements(
        container,
        "ins",
        annotation.ins_w_id,
        annotation.inserted_text,
      ),
      ...docxRevisionElements(
        container,
        "del",
        annotation.del_w_id,
        annotation.deleted_text,
      ),
    ];
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    return !!target;
  }

  // A change asked for while the document is hidden is shown once the
  // document has opened and rendered it.
  const pendingEdit = useRef<EditAnnotation | null>(null);
  function viewEdit(annotation: EditAnnotation) {
    if (showDocument && scrollToEdit(annotation)) return;
    pendingEdit.current = annotation;
    setDocumentOpen(true);
  }
  useEffect(() => {
    const pane = documentPane.current;
    if (!showDocument || !pane || !pendingEdit.current) return;
    const attempt = () => {
      if (pendingEdit.current && scrollToEdit(pendingEdit.current)) stop();
    };
    const observer = new MutationObserver(attempt);
    const timeout = setTimeout(() => stop(), 15_000);
    function stop() {
      pendingEdit.current = null;
      observer.disconnect();
      clearTimeout(timeout);
    }
    observer.observe(pane, { childList: true, subtree: true });
    attempt();
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [showDocument, selected?.id]);

  const documentPanel =
    showDocument && selected ? (
      <section
        ref={documentPane}
        aria-label="Reviewed document"
        className={`flex min-h-[24rem] min-w-0 flex-col overflow-hidden @[41rem]/run-layout:min-h-0 ${EDITOR_SURFACE_CLASS}`}
      >
        <div
          className={`flex items-center gap-2 ${PLAYBOOK_PANE_HEADER_CLASS}`}
        >
          <FileTypeIcon
            fileType={selected.documentName ?? ""}
            className="h-4 w-4"
          />
          <h2
            className={`min-w-0 flex-1 truncate ${PLAYBOOK_SIDE_TITLE_CLASS}`}
            title={runTitle(selected)}
          >
            {runTitle(selected)}
          </h2>
          <TextButtonUI
            size="icon-xs"
            className="-my-0.5 h-6 shrink-0"
            aria-label="Close document"
            title="Close document"
            onClick={() => setDocumentOpen(false)}
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </TextButtonUI>
        </div>
        <div className="flex min-h-0 flex-1 flex-col pb-4 pt-2 md:pb-5">
          {/\.docx$/i.test(selected.documentName ?? "") ? (
            <DocxView
              key={selected.documentId}
              documentId={selected.documentId!}
              refetchKey={documentRevision}
              filename={selected.documentName ?? undefined}
              canEdit={false}
              defaultMode="view"
              // Read-only here; changes are accepted from the results.
              toolbarVisible={false}
              rounded={false}
            />
          ) : (
            <PdfView
              key={selected.documentId}
              doc={{ document_id: selected.documentId! }}
              rounded={false}
            />
          )}
        </div>
      </section>
    ) : null;
  const resultsPanel = (
    <section
      aria-label="Run results"
      className={`@container flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden @[48rem]:min-h-0 @[41rem]/run-layout:min-h-0 ${EDITOR_SURFACE_CLASS}`}
    >
      {selected ? (
        <>
          <div
            className={`flex items-center gap-3 ${PLAYBOOK_PANE_HEADER_CLASS}`}
          >
            {/* The selected row, and the document pane when open, name the
                document; the heading says what the pane holds. */}
            <h2 className={`min-w-0 flex-1 ${PLAYBOOK_PANE_TITLE_CLASS}`}>
              Run results
            </h2>
            {selected.documentId && (
              <TextButtonUI
                size="xs"
                className="-my-0.5 shrink-0"
                aria-pressed={showDocument}
                onClick={() => setDocumentOpen((open) => !open)}
              >
                <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                View document
              </TextButtonUI>
            )}
          </div>
          <div
            className={`min-h-0 flex-1 overflow-y-auto ${PLAYBOOK_PANE_BODY_CLASS}`}
          >
            {selected.status === "running" ? (
              <div className="space-y-4">
                <RunDetails run={selected} />
                <div
                  role="status"
                  className="flex flex-col items-center justify-center gap-2 py-12 text-center"
                >
                  <Loader2
                    aria-hidden="true"
                    className="h-5 w-5 animate-spin text-blue-600 motion-reduce:animate-none"
                  />
                  <p className="text-sm text-gray-900">
                    Reviewing {runTitle(selected)}…
                  </p>
                  <p className="max-w-xs text-xs text-gray-500">
                    The review keeps running if you leave this page. Its
                    findings appear here when it finishes.
                  </p>
                </div>
              </div>
            ) : (
              <RunResults
                run={selected}
                issuesOnly={issuesOnly}
                onIssuesOnlyChange={setIssuesOnly}
                resolved={resolved}
                onViewEdit={viewEdit}
                onEditResolved={(editId, status) => {
                  setResolved((current) => ({ ...current, [editId]: status }));
                  // Show the document as it now stands.
                  setDocumentRevision((count) => count + 1);
                }}
              />
            )}
          </div>
        </>
      ) : (
        all !== null && (
          <div
            className={`flex min-h-0 flex-1 items-center justify-center ${PLAYBOOK_PANE_EMPTY_CLASS}`}
          >
            <EmptyState
              title="No runs yet"
              description="Run this playbook on a contract to see your findings here."
              action={
                canRun && (
                  <PillButtonUI tone="black" onClick={onNewRun}>
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                    New run
                  </PillButtonUI>
                )
              }
              className="w-fit max-w-full py-12"
            />
          </div>
        )
      )}
    </section>
  );

  return (
    <PlaybookPanels
      resizeLabel="Resize runs panel"
      sidebar={
        <section
          aria-label="Your runs"
          className={`flex min-h-0 min-w-0 flex-col ${EDITOR_SURFACE_CLASS}`}
        >
          <div
            className={`flex items-center justify-between gap-2 ${PLAYBOOK_SIDE_HEADER_CLASS}`}
          >
            {/* Runs are listed per person: another member's are not shown. */}
            <h2 className={PLAYBOOK_SIDE_TITLE_CLASS}>Your runs</h2>
            <TextButtonUI
              size="icon-xs"
              className="-my-0.5 h-6"
              aria-label="New run"
              title="New run"
              disabled={!canRun}
              onClick={onNewRun}
            >
              <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            </TextButtonUI>
          </div>
          <div
            className={`max-h-64 min-h-0 space-y-1 overflow-y-auto @[48rem]:max-h-none @[48rem]:flex-1 ${PLAYBOOK_SIDE_LIST_CLASS}`}
          >
            {all === null ? (
              <div aria-hidden="true" className="space-y-3 px-2 py-1.5">
                {["w-3/4", "w-1/2", "w-2/3"].map((width) => (
                  <SkeletonLine key={width} className={width} />
                ))}
              </div>
            ) : error ? (
              <p role="alert" className="px-2 py-1.5 text-xs text-red-600">
                {error}{" "}
                <button
                  type="button"
                  onClick={() => {
                    setRuns(null);
                    setError(null);
                    setAttempt((count) => count + 1);
                  }}
                  className="underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                  Try again
                </button>
              </p>
            ) : all.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-gray-500">None yet.</p>
            ) : (
              all.map((run) => {
                // The form, while open, takes the place of any run.
                const active = !composing && run.id === selected?.id;
                return (
                  // One line per run, like the References list.
                  <button
                    key={run.id}
                    type="button"
                    aria-pressed={active}
                    // The date tells repeat reviews of one document apart.
                    title={`${runTitle(run)} · ${formatDateTime(run.startedAt)}`}
                    onClick={() => {
                      setSelectedId(run.id);
                      onCloseNewRun();
                    }}
                    className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${active ? "theme-dropdown-selected text-gray-900" : "theme-dropdown-item text-gray-600 hover:text-gray-900"}`}
                  >
                    {run.status === "running" ? (
                      <Loader2
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600 motion-reduce:animate-none"
                      />
                    ) : (
                      <FileTypeIcon
                        fileType={run.documentName ?? ""}
                        className="h-3.5 w-3.5"
                      />
                    )}
                    <span className="min-w-0 truncate">{runTitle(run)}</span>
                    {run.status === "running" && (
                      <span className="sr-only">, running</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </section>
      }
    >
      {composing ? (
        newRun
      ) : (
        // One layout either way, so opening the document keeps the results
        // mounted and scrolled where they were.
        <PlaybookPanels
          variant="trailing"
          resizeLabel="Resize document panel"
          sidebar={documentPanel}
        >
          {resultsPanel}
        </PlaybookPanels>
      )}
    </PlaybookPanels>
  );
}

type EditHandlers = {
  resolved: Record<string, "accepted" | "rejected">;
  onViewEdit: (annotation: EditAnnotation) => void;
  onEditResolved: (editId: string, status: "accepted" | "rejected") => void;
};

/** What was reviewed, how, and when: at the top of a run's results. */
function RunDetails({ run }: { run: PlaybookRun }) {
  const headingId = useId();
  return (
    // The same grey card as the new run's document area.
    <section
      aria-labelledby={headingId}
      className="space-y-2 rounded-xl bg-gray-100 px-4 py-3"
    >
      <h3 id={headingId} className="text-sm font-medium text-gray-900">
        Run details
      </h3>
      <dl className="flex flex-wrap gap-x-8 gap-y-2">
        <div className="min-w-0">
          <dt className="text-xs text-gray-500">Document</dt>
          <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-gray-900">
            <FileTypeIcon
              fileType={run.documentName ?? ""}
              className="h-3.5 w-3.5 shrink-0"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {runTitle(run)}
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-gray-500">Model</dt>
          <dd className="mt-0.5 text-sm text-gray-900">
            {modelDisplayName(run.model)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-gray-500">Scope</dt>
          <dd className="mt-0.5 text-sm text-gray-900">
            {run.reviewScope === "issues" ? "Issues only" : "Full review"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-gray-500">Posture</dt>
          <dd className="mt-0.5 text-sm text-gray-900">
            {run.reviewMode === "permissive" ? "Permissive" : "Strict"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-gray-500">Started</dt>
          <dd className="mt-0.5 text-sm text-gray-900">
            <time dateTime={run.startedAt}>{formatDateTime(run.startedAt)}</time>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** What an issues-only review reports, and what the issues view shows. */
const ISSUE_STATUSES = new Set<PlaybookFinding["status"]>([
  "unacceptable",
  "missing_required",
  "needs_review",
]);

function RunResults({
  run,
  issuesOnly,
  onIssuesOnlyChange,
  ...edits
}: {
  run: PlaybookRun;
  /** Hides what passed or did not apply; nothing is removed from the run. */
  issuesOnly: boolean;
  onIssuesOnlyChange: (issuesOnly: boolean) => void;
} & EditHandlers) {
  const summaryId = useId();
  const findingsId = useId();
  const settings = <RunDetails run={run} />;
  if (run.error)
    return (
      <div className="space-y-4">
        {settings}
        <p role="alert" className="text-sm text-red-600">
          {run.error}
        </p>
      </div>
    );
  const isWordSource = !!run.documentName && /\.docx?$/i.test(run.documentName);
  // An issues-only run has nothing else to hide.
  const canFilter = run.reviewScope !== "issues" && run.findings.length > 0;
  const filtering = canFilter && issuesOnly;
  const shown = filtering
    ? run.findings.filter((finding) => ISSUE_STATUSES.has(finding.status))
    : run.findings;
  const groups = FINDING_GROUPS.map((group) => ({
    ...group,
    findings: shown.filter((finding) =>
      group.statuses.includes(finding.status),
    ),
  })).filter((group) => group.findings.length > 0);
  return (
    <div className="space-y-4">
      {settings}
      {run.summary && (
        <section aria-labelledby={summaryId} className="space-y-1.5">
          <h3 id={summaryId} className="text-sm font-medium text-gray-900">
            Summary of results
          </h3>
          <p className="text-sm leading-relaxed text-gray-700">{run.summary}</p>
        </section>
      )}
      {run.documentName && !isWordSource && (
        <p className="text-xs text-gray-500">
          This review used extracted text from{" "}
          <span className="font-medium">{run.documentName}</span>. For a
          formatting-preserving Word redline, provide the original DOCX in
          Assistant; if it is unavailable, Mike can create a text-reconstructed
          DOCX and will warn that formatting may differ.
        </p>
      )}
      <section aria-labelledby={findingsId} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <h3 id={findingsId} className="text-sm font-medium text-gray-900">
            Findings
          </h3>
          {canFilter && (
            <div role="group" aria-label="Findings to show">
              <ModalSegmentedToggle
                size="sm"
                surface="flat"
                value={issuesOnly ? "issues" : "all"}
                onChange={(value) => onIssuesOnlyChange(value === "issues")}
                options={[
                  { value: "all", label: "All findings" },
                  { value: "issues", label: "Issues only" },
                ]}
              />
            </div>
          )}
        </div>
        {groups.length === 0 && run.status === "completed" && (
          <p className="text-sm text-gray-500">
            {filtering || run.reviewScope === "issues"
              ? "No issues found."
              : "No findings."}
          </p>
        )}
        {groups.map((group) => (
          <FindingGroup key={group.title} {...group} {...edits} />
        ))}
      </section>
    </div>
  );
}

function FindingGroup({
  title,
  dot,
  findings,
  ...edits
}: {
  title: string;
  dot: string;
  findings: PlaybookFinding[];
} & EditHandlers) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 space-y-3 rounded-2xl bg-gray-100/70 p-3 md:p-4"
    >
      <h4
        id={headingId}
        className="flex items-center gap-2 text-sm font-medium text-gray-900"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${dot}`}
        />
        {title}
        <span className="font-normal text-gray-500">{findings.length}</span>
      </h4>
      {findings.map((finding) => (
        <FindingCard key={finding.id} finding={finding} {...edits} />
      ))}
    </section>
  );
}

/** A labelled part of a finding, so it is clear what each block of text is. */
function FindingPart({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      {children}
    </div>
  );
}

/** The contract language with the recommended edits marked in place. */
function Redline({ before, after }: { before: string; after: string }) {
  const segments = useMemo(() => diffWords(before, after), [before, after]);
  return (
    <p className="whitespace-pre-wrap rounded-lg bg-gray-100 px-3 py-2 text-xs leading-relaxed text-gray-800 [overflow-wrap:anywhere]">
      {segments.map((segment, index) =>
        segment.type === "removed" ? (
          <del
            key={index}
            className="rounded-sm bg-red-50 text-red-700 decoration-red-400"
          >
            <span className="sr-only">Removed: </span>
            {segment.text}
          </del>
        ) : segment.type === "added" ? (
          <ins
            key={index}
            className="rounded-sm bg-emerald-50 text-emerald-700 no-underline"
          >
            <span className="sr-only">Added: </span>
            {segment.text}
          </ins>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

function FindingCard({
  finding,
  resolved,
  onViewEdit,
  onEditResolved,
}: { finding: PlaybookFinding } & EditHandlers) {
  const missing = finding.status === "missing_required";
  return (
    <article
      className={`min-w-0 space-y-3 rounded-xl p-3 md:p-4 ${LIQUID_GLASS_FLAT_CLASS}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="min-w-0 text-sm font-medium text-gray-900 [overflow-wrap:anywhere]">
          {finding.ruleName}
        </h4>
        <span className={`shrink-0 text-xs ${STATUS_TONE[finding.status]}`}>
          {STATUS_LABEL[finding.status] ?? finding.status}
        </span>
      </div>
      {finding.location && (
        <FindingPart label="Where">
          <p className="text-sm text-gray-700 [overflow-wrap:anywhere]">
            {finding.location}
          </p>
        </FindingPart>
      )}
      {finding.analysis && (
        <FindingPart label="Assessment">
          <p className="text-sm leading-relaxed text-gray-700">
            {finding.analysis}
          </p>
        </FindingPart>
      )}
      {/* With a suggestion, the diff shows the contract language too. */}
      {finding.quote && !finding.suggestedText && (
        <FindingPart label="Contract language">
          <TextSlabUI className="text-xs text-gray-600">
            <blockquote>{finding.quote}</blockquote>
          </TextSlabUI>
        </FindingPart>
      )}
      {finding.edit ? (
        // The change is in the document as a tracked change: decide it here.
        <FindingPart
          label={missing ? "Recommended clause to add" : "Recommended change"}
        >
          <EditCard
            annotation={finding.edit}
            resolvedStatus={resolved[finding.edit.edit_id]}
            onViewClick={onViewEdit}
            onResolved={({ editId, status }) => onEditResolved(editId, status)}
          />
        </FindingPart>
      ) : (
        finding.suggestedText && (
          <FindingPart
            label={
              missing || !finding.quote
                ? "Recommended clause to add"
                : "Recommended changes"
            }
          >
            <Redline
              before={missing ? "" : finding.quote}
              after={finding.suggestedText}
            />
          </FindingPart>
        )
      )}
    </article>
  );
}

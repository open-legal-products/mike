"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Play } from "lucide-react";
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
import { diffWords } from "@/app/lib/wordDiff";
import { modelDisplayName } from "@/shared/lib/modelCatalog";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import { PlaybookPanels } from "./PlaybookPanels";
import {
  PLAYBOOK_PANE_BODY_CLASS,
  PLAYBOOK_PANE_EMPTY_CLASS,
  PLAYBOOK_PANE_HEADER_CLASS,
  PLAYBOOK_PANE_LIST_CLASS,
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
 * and the selected run's summary and findings on the right. A run finished on
 * this page arrives as `latestRun` and is selected.
 */
export function PlaybookRuns({
  playbookId,
  latestRun,
  initialRunId = null,
  canRun,
  onRun,
}: {
  playbookId: string;
  latestRun: PlaybookRun | null;
  /** A run to open first, such as one chosen from the list of all runs. */
  initialRunId?: string | null;
  canRun: boolean;
  onRun: () => void;
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
        setRuns([]);
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
  const documentPane = useRef<HTMLElement>(null);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [resolved, setResolved] = useState<
    Record<string, "accepted" | "rejected">
  >({});

  /** Scrolls the reviewed document to a tracked change. */
  function viewEdit(annotation: EditAnnotation) {
    const container = documentPane.current?.querySelector(
      ".docx-view-container",
    );
    if (!container) return;
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
  }

  const documentPanel = selected?.documentId ? (
    <section
      ref={documentPane}
      aria-label="Reviewed document"
      className={`flex min-h-[24rem] min-w-0 flex-col overflow-hidden @[41rem]/run-layout:min-h-0 ${EDITOR_SURFACE_CLASS}`}
    >
      <div className={`flex items-center gap-2 ${PLAYBOOK_PANE_HEADER_CLASS}`}>
        <FileTypeIcon
          fileType={selected.documentName ?? ""}
          className="h-4 w-4"
        />
        <h2
          className="min-w-0 truncate text-sm font-medium text-gray-900"
          title={runTitle(selected)}
        >
          {runTitle(selected)}
        </h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col pb-4 pt-2 md:pb-5">
        {/\.docx$/i.test(selected.documentName ?? "") ? (
          <DocxView
            key={selected.documentId}
            documentId={selected.documentId}
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
            doc={{ document_id: selected.documentId }}
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
          <div className={`flex items-baseline gap-3 ${PLAYBOOK_PANE_HEADER_CLASS}`}>
            <h2
              className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900"
              title={runTitle(selected)}
            >
              {runTitle(selected)}
            </h2>
            <time
              dateTime={selected.startedAt}
              className="shrink-0 text-xs text-gray-500"
            >
              {formatDateTime(selected.startedAt)}
            </time>
          </div>
          <div className={`min-h-0 flex-1 overflow-y-auto ${PLAYBOOK_PANE_BODY_CLASS}`}>
            <RunResults
              run={selected}
              resolved={resolved}
              onViewEdit={viewEdit}
              onEditResolved={(editId, status) => {
                setResolved((current) => ({ ...current, [editId]: status }));
                // Show the document as it now stands.
                setDocumentRevision((count) => count + 1);
              }}
            />
          </div>
        </>
      ) : (
        all !== null && (
          <div className={`flex min-h-0 flex-1 items-center justify-center ${PLAYBOOK_PANE_EMPTY_CLASS}`}>
            <EmptyState
              title="No runs yet"
              description="Run this playbook on a contract to see your findings here."
              action={
                canRun && (
                  <PillButtonUI tone="black" onClick={onRun}>
                    <Play aria-hidden="true" className="h-3.5 w-3.5" />
                    Run
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
          <div className={`flex items-center ${PLAYBOOK_PANE_HEADER_CLASS}`}>
            {/* Runs are listed per person: another member's are not shown. */}
            <h2 className="text-sm font-medium text-gray-900">Your runs</h2>
          </div>
          <div className={`max-h-64 min-h-0 space-y-1 overflow-y-auto @[48rem]:max-h-none @[48rem]:flex-1 ${PLAYBOOK_PANE_LIST_CLASS}`}>
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
                const active = run.id === selected?.id;
                return (
                  // One line per run, like the References list.
                  <button
                    key={run.id}
                    type="button"
                    aria-pressed={active}
                    // The date tells repeat reviews of one document apart.
                    title={`${runTitle(run)} · ${formatDateTime(run.startedAt)}`}
                    onClick={() => setSelectedId(run.id)}
                    className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${active ? "theme-dropdown-selected text-gray-900" : "theme-dropdown-item text-gray-600 hover:text-gray-900"}`}
                  >
                    <FileTypeIcon
                      fileType={run.documentName ?? ""}
                      className="h-3.5 w-3.5"
                    />
                    <span className="min-w-0 truncate">{runTitle(run)}</span>
                  </button>
                );
              })
            )}
          </div>
        </section>
      }
    >
      {documentPanel ? (
        <PlaybookPanels
          variant="results"
          resizeLabel="Resize run results panel"
          sidebar={resultsPanel}
        >
          {documentPanel}
        </PlaybookPanels>
      ) : (
        resultsPanel
      )}
    </PlaybookPanels>
  );
}

type EditHandlers = {
  resolved: Record<string, "accepted" | "rejected">;
  onViewEdit: (annotation: EditAnnotation) => void;
  onEditResolved: (editId: string, status: "accepted" | "rejected") => void;
};

function RunResults({ run, ...edits }: { run: PlaybookRun } & EditHandlers) {
  const summaryId = useId();
  const settings = (
    <dl className="flex flex-wrap gap-x-8 gap-y-2">
      <div className="min-w-0">
        <dt className="text-xs text-gray-500">Model</dt>
        <dd className="mt-0.5 text-sm text-gray-900">
          {modelDisplayName(run.model)}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-gray-500">Mode</dt>
        <dd className="mt-0.5 text-sm text-gray-900">
          {run.reviewMode === "permissive" ? "Permissive" : "Strict"}
        </dd>
      </div>
    </dl>
  );
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
  const groups = FINDING_GROUPS.map((group) => ({
    ...group,
    findings: run.findings.filter((finding) =>
      group.statuses.includes(finding.status),
    ),
  })).filter((group) => group.findings.length > 0);
  return (
    <div className="space-y-4">
      {settings}
      {run.summary && (
        <section aria-labelledby={summaryId} className="space-y-1.5">
          <h3 id={summaryId} className="text-sm font-medium text-gray-900">
            Summary
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
      {groups.length === 0 && run.status === "completed" && (
        <p className="text-sm text-gray-500">No findings.</p>
      )}
      {groups.map((group) => (
        <FindingGroup key={group.title} {...group} {...edits} />
      ))}
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
      <h3
        id={headingId}
        className="flex items-center gap-2 text-sm font-medium text-gray-900"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${dot}`}
        />
        {title}
        <span className="font-normal text-gray-500">{findings.length}</span>
      </h3>
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

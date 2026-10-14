"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  CalendarDays,
  ChevronDown,
  Download,
  Eye,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  X,
} from "lucide-react";
import { getAuditHistory, type AuditActor, type AuditEvent } from "@/app/lib/mikeApi";
import { HistoryActorFilter } from "./HistoryActorFilter";
import { runUserExport } from "@/app/lib/asyncExport";
import { appendUniqueRows } from "@/app/lib/paginatedRows";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { FieldLabel } from "@/app/components/ui/form-field";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import {
  RowActions,
  closeRowActionMenus,
} from "@/app/components/shared/RowActions";
import { SelectionActionsMenu } from "@/app/components/shared/SelectionActionsMenu";
import {
  HistoryDatePicker,
  localDateValue,
  parseHistoryDate,
} from "./HistoryDatePicker";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
  SkeletonLine,
  SkeletonCheckbox,
  TABLE_CHECKBOX_CLASS,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  TableSortFilter,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  type TableSortDirection,
  TableStickyCell,
  TablePrimaryCell,
} from "@/app/components/shared/TablePrimitive";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import { HistorySubjectIcon } from "./HistorySubjectIcon";
import {
  HISTORY_APPLICATION_ICONS,
  HistoryApplicationIcon,
} from "./HistoryApplicationIcon";
import { HistoryEventModal } from "./HistoryEventModal";
import {
  ACTION_LABELS,
  SURFACE_LABELS,
  auditAction,
  auditActor,
  auditSubject,
  auditSubjectEmail,
  auditTimestamp,
  auditDestination,
  auditPrivateAccess,
} from "./auditPresentation";
import { HistorySkeuoIcon } from "@/app/components/shared/HistorySkeuoIcon";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { HeaderButtonUI } from "@/shared/ui/HeaderButtonsUI";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSurface,
  DropdownTrigger,
} from "@/shared/ui/dropdown";

const STATUS_DOT_STYLES: Record<string, string> = {
  completed: "bg-green-400/80",
  cancelled: "bg-amber-400/80",
  failed: "bg-red-400/80",
};

const GLASS_DOT =
  "h-2.5 w-2.5 shrink-0 rounded-full border border-white/80 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_1px_rgba(255,255,255,0.55)]";

const STATUS_OPTIONS = [
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "failed", label: "Failed" },
];

const ACTION_OPTIONS = Object.entries(ACTION_LABELS).map(([value, label]) => ({
  value,
  label,
}));

const SURFACE_OPTIONS = Object.entries(SURFACE_LABELS).map(
  ([value, label]) => ({ value, label, icon: HISTORY_APPLICATION_ICONS[value] }),
);

type AuditSortKey = "created_at" | "title";

type HistoryDateRange = { from: string; to: string };

const DATE_RANGE_PRESETS = [
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "custom", label: "Custom range" },
] as const;

type HistoryDatePreset = (typeof DATE_RANGE_PRESETS)[number]["value"];

function presetDateRange(
  preset: Exclude<HistoryDatePreset, "custom">,
): HistoryDateRange {
  let end = new Date();
  const start = new Date(end);
  if (preset === "last7" || preset === "last30") {
    // Both endpoints are inclusive: today plus the preceding 6 or 29 days.
    start.setDate(end.getDate() - (preset === "last7" ? 6 : 29));
  } else if (preset === "thisMonth" || preset === "lastMonth") {
    start.setDate(1);
    if (preset === "lastMonth") {
      start.setMonth(start.getMonth() - 1);
      end = new Date(end.getFullYear(), end.getMonth(), 0);
    }
  }
  return { from: localDateValue(start), to: localDateValue(end) };
}

function matchingDatePreset(range: HistoryDateRange): HistoryDatePreset {
  return (
    DATE_RANGE_PRESETS.find(({ value }) => {
      if (value === "custom") return false;
      const preset = presetDateRange(value);
      return range.from === preset.from && range.to === preset.to;
    })?.value ?? "custom"
  );
}

function dateRangeError(range: HistoryDateRange): string | null {
  if (!range.from || !range.to) return "Choose a start and end date.";
  if (!parseHistoryDate(range.from) || !parseHistoryDate(range.to)) {
    return "Enter a valid date in YYYY-MM-DD format.";
  }
  if (range.from > range.to) return "End date must be on or after start date.";
  if (range.to > localDateValue(new Date())) {
    return "Dates cannot be in the future.";
  }
  return null;
}

function formatRangeDate(value: string): string {
  if (!value) return "Open";
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatStatus(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function AuditHistory({
  orgId,
  onBack,
}: {
  orgId?: string;
  onBack?: () => void;
}) {
  const title = orgId ? "Audit log" : "My Activity";
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const exportingRef = useRef(false);
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);
  const [previewDocument, setPreviewDocument] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [actorSelection, setActorSelection] = useState<{ orgId: string; user: AuditActor | null } | null>(null);
  const actor = actorSelection?.orgId === orgId ? actorSelection?.user : null;
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [surface, setSurface] = useState<string | null>(null);
  const [sort, setSort] = useState<{
    key: AuditSortKey;
    direction: TableSortDirection;
  } | null>(null);
  const [{ from, to }, setDateRange] = useState(() =>
    presetDateRange("last30"),
  );
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      // Observer callbacks and manual retries may arrive before React renders.
      if (append && controllerRef.current) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setError(false);
      setLoadingMore(append);
      setLoading(!append);
      if (!append) {
        closeRowActionMenus();
        setSelectedIds(new Set());
        setEvents([]);
        setHasMore(false);
        setPage(1);
      }
      try {
        const out = await getAuditHistory(
          {
            ...(orgId ? { orgId } : {}),
            actorUserId: actor?.user_id,
            q: debouncedSearch || undefined,
            action: action || undefined,
            status: status || undefined,
            surface: surface || undefined,
            from: from || undefined,
            to: to || undefined,
            sortBy: sort?.key,
            sortDirection: sort?.direction,
            page: nextPage,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setError(false);
        setEvents((current) =>
          append ? appendUniqueRows(current, out.events) : out.events,
        );
        setHasMore(
          out.events.length > 0 && nextPage * out.pageSize < out.total,
        );
        setPage(nextPage);
      } catch {
        if (controller.signal.aborted) return;
        if (!append) {
          setEvents([]);
          setHasMore(false);
        }
        setError(true);
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [orgId, actor?.user_id, action, debouncedSearch, from, sort, status, surface, to],
  );

  useEffect(() => {
    void load(1, false);
    return () => controllerRef.current?.abort();
  }, [load]);

  // The CSV is built by a background job rather than in the request: a wide
  // filter can sweep thousands of events, and the artifact outlives the tab.
  const handleExport = async (range: HistoryDateRange, eventIds?: string[]) => {
    if (exportingRef.current) return;
    if (eventIds && eventIds.length > 2000) {
      setActionError("Select up to 2,000 entries to export at once.");
      return;
    }
    exportingRef.current = true;
    setExporting(true);
    setExportError(false);
    setActionError(null);
    try {
      const { blob, filename } = await runUserExport("audit-csv", {
        ...(orgId ? { org_id: orgId } : {}),
        ...(eventIds
          ? { event_ids: eventIds }
          : {
              actor_user_id: actor?.user_id,
              q: search.trim() || undefined,
              action: action || undefined,
              status: status || undefined,
              surface: surface || undefined,
              from: range.from,
              to: range.to,
            }),
        sort_by: sort?.key,
        sort_dir: sort?.direction,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        filename ?? (orgId ? "organization-audit.csv" : "my-activity.csv");
      anchor.click();
      URL.revokeObjectURL(url);
      if (!eventIds) setExportOpen(false);
    } catch {
      if (eventIds)
        setActionError("Your export could not be created. Please try again.");
      else setExportError(true);
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };

  const setSortDirection = (
    key: AuditSortKey,
    direction: TableSortDirection | null,
  ) => {
    setSort(direction ? { key, direction } : null);
  };

  const sortValue = (key: AuditSortKey) =>
    sort?.key === key ? sort.direction : null;

  const dateSelector = (
    <DateRangeDropdown
      from={from}
      to={to}
      onChange={(range) => setDateRange(range)}
    />
  );

  const initialLoading = loading && events.length === 0;
  const selectedEvents = events.filter((event) => selectedIds.has(event.id));
  const allSelected =
    events.length > 0 && selectedEvents.length === events.length;
  const toggleSelection = (id: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Selected rows share their actions across the toolbar, ellipsis, and
  // right-click menus. An unselected row acts only on that entry.
  const renderActions = (
    targets: AuditEvent[],
    selection: boolean,
    close: () => void,
  ) => {
    const single = targets.length === 1 ? targets[0] : null;
    const privateAccess = single && orgId ? auditPrivateAccess(single) : null;
    const destination = single && !privateAccess ? auditDestination(single) : null;
    return (
      <>
        {selection && (
          <DropdownItem
            onSelect={() => {
              close();
              setSelectedIds(new Set());
            }}
          >
            <X className="h-3.5 w-3.5" />
            Deselect rows
          </DropdownItem>
        )}
        {single && (
          <DropdownItem
            onSelect={() => {
              close();
              setPreviewDocument(false);
              setSelectedEvent(single);
            }}
          >
            <Eye className="h-3.5 w-3.5" />
            View details
          </DropdownItem>
        )}
        {single?.document_id && !privateAccess && (
          <DropdownItem
            onSelect={() => {
              close();
              setPreviewDocument(true);
              setSelectedEvent(single);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open document
          </DropdownItem>
        )}
        {destination && (
          <DropdownItem asChild onSelect={close}>
            <Link href={destination.href}>
              <ExternalLink className="h-3.5 w-3.5" />
              {destination.label}
            </Link>
          </DropdownItem>
        )}
        <DropdownItem
          disabled={exporting}
          onSelect={() => {
            close();
            void handleExport(
              { from, to },
              targets.map((event) => event.id),
            );
          }}
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {selection ? "Export selected" : "Export this entry"}
        </DropdownItem>
      </>
    );
  };
  const createdHeader = (
    <>
      <span className="mr-1">Date &amp; time</span>
      {!initialLoading && (
        <TableSortFilter
          label="Sort by date and time"
          value={sortValue("created_at")}
          onChange={(direction) => setSortDirection("created_at", direction)}
          widthClassName="w-52"
        />
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        shrink
        breadcrumbs={[
          {
            label: orgId ? "Organization" : "Settings",
            onClick: onBack,
          },
          { label: title },
        ]}
        actions={[
          {
            type: "search",
            value: search,
            onChange: setSearch,
            placeholder: orgId ? "Search audit log…" : "Search my activity…",
          },
          {
            type: "custom",
            render: (
              <Dropdown modal={false}>
                <DropdownTrigger asChild>
                  <HeaderButtonUI
                    iconOnly
                    aria-label={`${title} actions`}
                    title={`${title} actions`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </HeaderButtonUI>
                </DropdownTrigger>
                <DropdownContent align="end" className="w-44">
                  <DropdownItem
                    onSelect={() => {
                      setExportError(false);
                      setExportOpen(true);
                    }}
                  >
                    <Download className="h-4 w-4" />
                    Export
                  </DropdownItem>
                </DropdownContent>
              </Dropdown>
            ),
          },
        ]}
      />

      <TableToolbar
        leading={dateSelector}
        actions={
          selectedEvents.length > 0 && (
            <SelectionActionsMenu
              renderItems={(close) =>
                renderActions(selectedEvents, true, close)
              }
            />
          )
        }
      />

      <TableScrollArea
        header={
          <TableHeaderRow>
            <TableStickyCell header widthClassName="w-52 shrink-0">
              <input
                type="checkbox"
                className={TABLE_CHECKBOX_CLASS}
                aria-label="Select all loaded entries"
                checked={allSelected}
                disabled={!events.length}
                ref={(input) => {
                  if (input)
                    input.indeterminate =
                      selectedEvents.length > 0 && !allSelected;
                }}
                onChange={() =>
                  setSelectedIds(
                    allSelected
                      ? new Set()
                      : new Set(events.map((event) => event.id)),
                  )
                }
              />
              {createdHeader}
            </TableStickyCell>
            {orgId && (
              <TableHeaderCell className="w-64 pr-4">
                <span className="mr-1">Performed by</span>
                {!initialLoading && (
                  <HistoryActorFilter
                    key={orgId}
                    orgId={orgId}
                    value={actor ?? null}
                    onChange={(user) => setActorSelection({ orgId, user })}
                  />
                )}
              </TableHeaderCell>
            )}
            <TableHeaderCell className="w-48 pr-4">
              <span className="mr-1">Action</span>
              {!initialLoading && (
                <TableFilters
                  label="Filter by action"
                  value={action}
                  allLabel="All actions"
                  options={ACTION_OPTIONS}
                  onChange={setAction}
                  contentClassName="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto"
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-64 pr-6">
              <span className="mr-1">Affected</span>
              {!initialLoading && (
                <TableSortFilter
                  label="Sort by affected"
                  value={sortValue("title")}
                  onChange={(direction) => setSortDirection("title", direction)}
                  widthClassName="w-52"
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-32 pr-4">
              <span className="mr-1">Application</span>
              {!initialLoading && (
                <TableFilters
                  label="Filter by application"
                  value={surface}
                  allLabel="All applications"
                  options={SURFACE_OPTIONS}
                  onChange={setSurface}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="ml-auto w-28">
              <span className="mr-1">Status</span>
              {!initialLoading && (
                <TableFilters
                  label="Filter by status"
                  value={status}
                  allLabel="All statuses"
                  options={STATUS_OPTIONS}
                  onChange={setStatus}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-10">
              <span className="sr-only">Actions</span>
            </TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {initialLoading ? (
          <HistoryLoadingRows organization={Boolean(orgId)} />
        ) : error && events.length === 0 ? (
          <TableBody className="flex">
            <TableEmptyState>
              <p className="font-serif text-2xl font-medium text-gray-900">
                {title} unavailable
              </p>
              <p className="mt-1 text-xs text-gray-400">
                {orgId ? "The audit log could not be loaded." : "Your activity could not be loaded."}
              </p>
              <PillButtonUI
                tone="white"
                className="mt-4"
                onClick={() => void load(1, false)}
              >
                Try again
              </PillButtonUI>
            </TableEmptyState>
          </TableBody>
        ) : events.length === 0 ? (
          <TableBody className="flex">
            <TableEmptyState>
              <HistorySkeuoIcon
                data-testid="history-empty-icon"
                className="mb-4 h-14 w-14"
              />
              <p className="font-serif text-2xl font-medium text-gray-900">
                {orgId ? "No audit events yet" : "No activity yet"}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                {orgId ? "Actions taken in this organization appear here." : "Actions appear here as you use the app."}
              </p>
            </TableEmptyState>
          </TableBody>
        ) : (
          <TableBody>
            {events.map((event) => {
              const selected = selectedIds.has(event.id);
              const subject = auditSubject(event);
              const subjectEmail = auditSubjectEmail(event);
              const actor = auditActor(event);
              const rowActions = (close: () => void) =>
                renderActions(
                  selected ? selectedEvents : [event],
                  selected,
                  close,
                );
              return (
                <TableRow
                  key={event.id}
                  selected={selected}
                  rightClickDropdown={rowActions}
                  role="button"
                  tabIndex={0}
                  aria-haspopup="dialog"
                  aria-label={`View details for ${subject.name === "-" ? auditAction(event) : subject.name}`}
                  className="h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                  onClick={(click) => {
                    click.currentTarget.focus();
                    setPreviewDocument(false);
                    setSelectedEvent(event);
                  }}
                  onKeyDown={(key) => {
                    if (key.target !== key.currentTarget) return;
                    if (key.key === "Enter" || key.key === " ") {
                      key.preventDefault();
                      setPreviewDocument(false);
                      setSelectedEvent(event);
                    }
                  }}
                >
                  <TablePrimaryCell
                    widthClassName="w-52 shrink-0"
                    className="items-center"
                    selected={selected}
                    onSelectionChange={() => toggleSelection(event.id)}
                    checkboxTitle={`Select ${event.title ?? auditAction(event)}`}
                  >
                    <time
                      dateTime={event.created_at}
                      title={auditTimestamp(event.created_at, true)}
                      className="whitespace-nowrap text-xs text-gray-700"
                    >
                      {auditTimestamp(event.created_at)}
                    </time>
                  </TablePrimaryCell>
                  {orgId && (
                    <TableCell
                      className="w-64 pr-4 text-xs text-gray-700"
                      title={[
                        actor,
                        event.user_email !== actor ? event.user_email : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {actor !== "System" && (
                          <UserAvatar
                            size="sm"
                            photo={event.user_profile_photo}
                            name={event.user_display_name}
                            email={event.user_email}
                          />
                        )}
                        <span className="truncate">{actor}</span>
                      </span>
                    </TableCell>
                  )}
                  <TableCell
                    className="w-48 pr-4 text-xs text-gray-700"
                    title={auditAction(event)}
                  >
                    {auditAction(event)}
                  </TableCell>
                  <TableCell
                    className="w-64 pr-6 text-xs text-gray-800"
                    title={`${subject.type}: ${subject.name}${subjectEmail && subjectEmail !== subject.name ? ` (${subjectEmail})` : ""}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {subject.name !== "-" && (
                        <HistorySubjectIcon event={event} avatarSize="sm" />
                      )}
                      <span className="truncate">{subject.name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="w-32 pr-4 text-xs text-gray-700">
                    {event.surface ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <HistoryApplicationIcon surface={event.surface} />
                        <span className="truncate">
                          {SURFACE_LABELS[event.surface] ?? event.surface}
                        </span>
                      </span>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="ml-auto w-28 text-xs text-gray-700">
                    <span className="inline-flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        data-testid={`status-dot-${event.id}`}
                        className={`${GLASS_DOT} ${STATUS_DOT_STYLES[event.status] ?? "bg-gray-400/80"}`}
                      />
                      {formatStatus(event.status)}
                    </span>
                  </TableCell>
                  <TableCell className="w-10">
                    <RowActions
                      ariaLabel={`Actions for ${event.title ?? auditAction(event)}`}
                      renderItems={rowActions}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
            <TableLoadMoreRow
              autoLoadOnVisible
              loading={loading}
              hasMore={hasMore}
              itemCount={events.length}
              loadingMore={loadingMore}
              hasError={error}
              onLoadMore={() => void load(page + 1, true)}
            />
          </TableBody>
        )}
      </TableScrollArea>
      <WarningPopup
        open={Boolean(actionError)}
        title="Export unavailable"
        message={actionError}
        onClose={() => setActionError(null)}
      />
      {selectedEvent && (
        <HistoryEventModal
          key={selectedEvent.id}
          title={title}
          personal={!orgId}
          initialPreview={previewDocument}
          event={selectedEvent}
          onAccessChange={() => void load(1, false)}
          onClose={() => setSelectedEvent(null)}
        />
      )}
      {exportOpen && (
        <HistoryExportModal
          title={title}
          organization={Boolean(orgId)}
          from={from}
          to={to}
          exporting={exporting}
          error={exportError}
          onClose={() => setExportOpen(false)}
          onExport={(range) => void handleExport(range)}
        />
      )}
    </div>
  );
}

function HistoryExportModal({
  title,
  organization,
  from,
  to,
  exporting,
  error,
  onClose,
  onExport,
}: {
  title: string;
  organization: boolean;
  from: string;
  to: string;
  exporting: boolean;
  error: boolean;
  onClose: () => void;
  onExport: (range: { from: string; to: string }) => void;
}) {
  const [range, setRange] = useState({ from, to });
  const validRange = !dateRangeError(range);

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      className="h-auto max-h-[calc(100dvh-2rem)]"
      breadcrumbs={[
        title,
        title === "My Activity" ? "Export My Activity" : "Export audit log",
      ]}
      cancelAction={{ label: "Cancel", onClick: onClose }}
      primaryAction={{
        label: exporting ? "Exporting…" : "Export CSV",
        icon: exporting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        ),
        disabled: exporting || !validRange,
        onClick: () => onExport(range),
      }}
    >
      <div
        data-modal-scroll="vertical"
        className="min-h-0 overflow-y-auto pb-5"
      >
        <p className="mb-4 text-sm text-gray-500">
          Current search and filters apply. Up to 2,000 events per export.
        </p>
        <fieldset disabled={exporting}>
          <HistoryDateRangeFields
            range={range}
            onChange={setRange}
            disabled={exporting}
          />
        </fieldset>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {organization ? "The audit log could not be exported." : "Your activity could not be exported."}{" "}
            Please try again.
          </p>
        )}
      </div>
    </Modal>
  );
}

function HistoryDateRangeFields({
  range,
  onChange,
  disabled = false,
  onPresetSelect,
  customAction,
}: {
  range: HistoryDateRange;
  onChange: (range: HistoryDateRange) => void;
  disabled?: boolean;
  onPresetSelect?: (range: HistoryDateRange) => void;
  customAction?: ReactNode;
}) {
  const id = useId();
  const [preset, setPreset] = useState(() => matchingDatePreset(range));
  const error = dateRangeError(range);
  const today = localDateValue(new Date());

  return (
    <div className="space-y-3 [&_label]:mb-1.5 [&_label]:text-xs">
      <div>
        <FieldLabel htmlFor={`${id}-preset`}>Date range</FieldLabel>
        <ModalSelect
          variant="flat"
          className="h-8 rounded-lg px-2.5 text-xs"
          id={`${id}-preset`}
          aria-label={`Date range: ${DATE_RANGE_PRESETS.find(({ value }) => value === preset)?.label}`}
          value={preset}
          options={DATE_RANGE_PRESETS}
          disabled={disabled}
          onChange={(value) => {
            const selected = DATE_RANGE_PRESETS.find(
              (option) => option.value === value,
            );
            if (!selected) return;
            setPreset(selected.value);
            if (selected.value !== "custom") {
              const nextRange = presetDateRange(selected.value);
              onChange(nextRange);
              onPresetSelect?.(nextRange);
            }
          }}
        />
      </div>
      {preset === "custom" && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3">
          <HistoryDatePicker
            id={`${id}-from`}
            label="From"
            disabled={disabled}
            value={range.from}
            max={range.to && range.to < today ? range.to : today}
            errorId={error ? `${id}-error` : undefined}
            onChange={(from) => onChange({ ...range, from })}
          />
          <HistoryDatePicker
            id={`${id}-to`}
            label="To"
            disabled={disabled}
            value={range.to}
            min={range.from || undefined}
            max={today}
            errorId={error ? `${id}-error` : undefined}
            onChange={(to) => onChange({ ...range, to })}
          />
        </div>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      {preset === "custom" && customAction}
    </div>
  );
}

function DateRangeDropdown({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftRange, setDraftRange] = useState({ from, to });
  const hasChanges = draftRange.from !== from || draftRange.to !== to;

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setDraftRange({ from, to });
    setOpen(nextOpen);
  };

  const handleConfirm = () => {
    if (!hasChanges || dateRangeError(draftRange)) return;
    onChange(draftRange);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <TabPillButtonUI
          active
          data-icon-position="right"
          className="pl-2.5 pr-2"
          aria-label={`Select date range: ${formatRangeDate(from)} – ${formatRangeDate(to)}`}
        >
          <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
          {formatRangeDate(from)} – {formatRangeDate(to)}
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </TabPillButtonUI>
      </PopoverTrigger>
      <PopoverContent
        asChild
        align="start"
        aria-label="Filter by date range"
        collisionPadding={16}
        className="w-80 max-w-[calc(100vw-2rem)] rounded-2xl"
      >
        <DropdownSurface>
          <HistoryDateRangeFields
            range={draftRange}
            onChange={setDraftRange}
            onPresetSelect={(range) => {
              onChange(range);
              setOpen(false);
            }}
            customAction={
              <div className="flex justify-end">
                <PillButtonUI
                  tone="black"
                  disabled={!hasChanges || Boolean(dateRangeError(draftRange))}
                  onClick={handleConfirm}
                >
                  Apply
                </PillButtonUI>
              </div>
            }
          />
        </DropdownSurface>
      </PopoverContent>
    </Popover>
  );
}

function HistoryLoadingRows({ organization }: { organization: boolean }) {
  return (
    <TableBody>
      {[1, 2, 3, 4, 5].map((row) => (
        <TableRow key={row} interactive={false} className="h-10">
          <TableStickyCell
            widthClassName="w-52 shrink-0"
            className="items-center"
          >
            <SkeletonCheckbox className="mr-3" />
            <SkeletonLine className="w-32" />
          </TableStickyCell>
          {organization && (
            <TableCell className="w-64 pr-4">
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-gray-100" />
                <SkeletonLine className="w-28" />
              </span>
            </TableCell>
          )}
          <TableCell className="w-48 pr-4">
            <SkeletonLine className="w-36" />
          </TableCell>
          <TableCell className="w-64 pr-6">
            <SkeletonLine className="w-44" />
          </TableCell>
          <TableCell className="w-32 pr-4">
            <span className="flex items-center gap-2">
              <SkeletonLine className="h-4 w-4 shrink-0" />
              <SkeletonLine className="w-16" />
            </span>
          </TableCell>
          <TableCell className="ml-auto w-28">
            <SkeletonLine className="w-16" />
          </TableCell>
          <TableCell className="w-10">
            <SkeletonLine className="w-6" />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  );
}

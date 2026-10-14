"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import {
  CalendarDays,
  Download,
  ExternalLink,
  Loader2,
  MoreHorizontal,
} from "lucide-react";
import { DayPicker, type Matcher } from "@daypicker/react";
import dayPickerStyles from "@daypicker/react/style.module.css";
import { getAuditHistory, type AuditEvent } from "@/app/lib/mikeApi";
import { runUserExport } from "@/app/lib/asyncExport";
import { appendUniqueRows } from "@/app/lib/paginatedRows";
import { Modal } from "@/app/components/modals/Modal";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PAGE_HEADER_TITLE_CLASS } from "@/app/components/shared/pageHeaderStyles";
import {
  SkeletonLine,
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
} from "@/app/components/shared/TablePrimitive";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import { HistorySkeuoIcon } from "@/app/components/shared/HistorySkeuoIcon";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { HeaderButtonUI } from "@/shared/ui/HeaderButtonsUI";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { cn } from "@/app/lib/utils";

const ACTION_LABELS: Record<string, string> = {
  "org.api_key.saved": "Provider key saved",
  "org.api_key.removed": "Provider key removed",
  "org.api_key.enabled": "Provider key enabled",
  "org.api_key.disabled": "Provider key disabled",
  "org.personal_api_keys.allowed": "Personal keys allowed",
  "org.personal_api_keys.blocked": "Personal keys blocked",
  "org.created": "Organization created",
  "org.deleted": "Organization deleted",
  "org.restored": "Organization restored",
  "org.purged": "Organization permanently deleted",
  "org.invite.created": "Invitation created",
  "org.invite.accepted": "Invitation accepted",
  "org.invite.declined": "Invitation declined",
  "org.invite.cancelled": "Invitation cancelled",
  "org.invite.resent": "Invitation renewed",
  "org.member.role_changed": "Member role changed",
  "org.logo.updated": "Logo updated",
  "org.logo.removed": "Logo removed",
  "org.router_models.updated": "Models updated",
  "org.departure.item.transferred": "Departed work transferred",
  "org.departure.item.archived": "Departed work archived",
  "org.departure.item.recovered": "Departed work recovered",
  "org.departure.item.deleted": "Departed work deleted",
  "org.departure.item.expired": "Departed work expired",
  "org.departure.member.departed": "Member departed",
  "org.member.removed": "Member removed",
  "org.member.left": "Member left",
  "org.data.deleted": "Organization data deleted",
  "chat.message": "Chat",
  "document.uploaded": "Document upload",
  "document.generated": "Generated document",
  "document.edited": "Document edit",
  "workflow.applied": "Workflow",
  "tabular.created": "Tabular review",
  "tabular.generated": "Tabular run",
  "export.chats": "Chat export",
  "export.account": "Account export",
  "export.tabular": "Review export",
};

const STATUS_DOT_STYLES: Record<string, string> = {
  completed: "bg-green-400/80",
  cancelled: "bg-amber-400/80",
  failed: "bg-red-400/80",
};

const STATUS_TEXT_STYLES: Record<string, string> = {
  completed: "text-green-600",
  cancelled: "text-amber-600",
  failed: "text-red-600",
};

const GLASS_DOT =
  "h-2.5 w-2.5 shrink-0 rounded-full border border-white/80 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_1px_rgba(255,255,255,0.55)]";

const SURFACE_LABELS: Record<string, string> = {
  assistant: "Assistant",
  project: "Project",
  word: "Word",
  tabular: "Tabular",
  workflows: "Workflows",
  account: "Account",
  organization: "Organization",
};

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
  ([value, label]) => ({ value, label }),
);

type AuditSortKey = "created_at" | "user_email" | "title" | "model";

function eventHref(event: AuditEvent): string | null {
  if (event.chat_id) {
    return event.project_id
      ? `/projects/${event.project_id}/assistant/chat/${event.chat_id}`
      : `/assistant/chat/${event.chat_id}`;
  }
  if (event.review_id) return `/tabular-reviews/${event.review_id}`;
  if (event.project_id) return `/projects/${event.project_id}`;
  return null;
}

function localDateValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function dateFromLocalValue(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function defaultDateRange(): {
  from: string;
  to: string;
} {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 30);
  return { from: localDateValue(start), to: localDateValue(end) };
}

function formatRangeDate(value: string): string {
  if (!value) return "Open";
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatCreatedAt(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
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
  const title = orgId ? "Audit log" : "History";
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [surface, setSurface] = useState<string | null>(null);
  const [sort, setSort] = useState<{
    key: AuditSortKey;
    direction: TableSortDirection;
  } | null>(null);
  const [{ from, to }, setDateRange] = useState(defaultDateRange);
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
        setEvents([]);
        setHasMore(false);
        setPage(1);
      }
      try {
        const out = await getAuditHistory(
          {
            ...(orgId ? { orgId } : {}),
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
    [orgId, action, debouncedSearch, from, sort, status, surface, to],
  );

  useEffect(() => {
    void load(1, false);
    return () => controllerRef.current?.abort();
  }, [load]);

  // The CSV is built by a background job rather than in the request: a wide
  // filter can sweep thousands of events, and the artifact outlives the tab.
  const handleExport = async (range: { from: string; to: string }) => {
    if (exporting) return;
    setExporting(true);
    setExportError(false);
    try {
      const { blob, filename } = await runUserExport("audit-csv", {
        ...(orgId ? { org_id: orgId } : {}),
        q: search.trim() || undefined,
        action: action || undefined,
        status: status || undefined,
        surface: surface || undefined,
        from: range.from,
        to: range.to,
        sort_by: sort?.key,
        sort_dir: sort?.direction,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename ?? "history-export.csv";
      anchor.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
    } catch {
      setExportError(true);
    } finally {
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

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        breadcrumbs={
          orgId
            ? [
                { label: "Organization Settings", onClick: onBack },
                { label: "Audit log" },
              ]
            : undefined
        }
        actions={[
          {
            type: "search",
            value: search,
            onChange: setSearch,
            placeholder: orgId ? "Search audit log…" : "Search history…",
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
      >
        <h1 className={`${PAGE_HEADER_TITLE_CLASS} text-gray-900`}>{title}</h1>
      </PageHeader>

      <TableToolbar leading={dateSelector} />

      <TableScrollArea
        header={
          <TableHeaderRow>
            <TableStickyCell header widthClassName="w-52 shrink-0">
              <span>Username</span>
            </TableStickyCell>
            <TableHeaderCell className="ml-auto w-52">
              <span className="mr-1">Email</span>
              {!initialLoading && (
                <TableSortFilter
                  label="Sort by email"
                  value={sortValue("user_email")}
                  align="right"
                  onChange={(direction) =>
                    setSortDirection("user_email", direction)
                  }
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-40">
              <span className="mr-1">Created</span>
              {!initialLoading && (
                <TableSortFilter
                  label="Sort by created date"
                  value={sortValue("created_at")}
                  onChange={(direction) =>
                    setSortDirection("created_at", direction)
                  }
                  widthClassName="w-52"
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-72">
              <span className="mr-1">Title</span>
              {!initialLoading && (
                <TableSortFilter
                  label="Sort by title"
                  value={sortValue("title")}
                  onChange={(direction) => setSortDirection("title", direction)}
                  widthClassName="w-52"
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-28">
              <span className="mr-1">Status</span>
              {!initialLoading && (
                <TableFilters
                  label="Filter by status"
                  value={status}
                  allLabel="All Statuses"
                  options={STATUS_OPTIONS}
                  onChange={setStatus}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-44">
              <span className="mr-1">Type</span>
              {!initialLoading && (
                <TableFilters
                  label="Filter by type"
                  value={action}
                  allLabel="All Types"
                  options={ACTION_OPTIONS}
                  onChange={setAction}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-32">
              <span className="mr-1">Application</span>
              {!initialLoading && (
                <TableFilters
                  label="Filter by application"
                  value={surface}
                  allLabel="All Applications"
                  options={SURFACE_OPTIONS}
                  onChange={setSurface}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-28">
              <span className="mr-1">Model</span>
              {!initialLoading && (
                <TableSortFilter
                  label="Sort by model"
                  value={sortValue("model")}
                  onChange={(direction) => setSortDirection("model", direction)}
                  widthClassName="w-52"
                />
              )}
            </TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {initialLoading ? (
          <HistoryLoadingRows />
        ) : error && events.length === 0 ? (
          <TableBody className="flex">
            <TableEmptyState>
              <p className="font-serif text-2xl font-medium text-gray-900">
                {title} unavailable
              </p>
              <p className="mt-1 text-xs text-gray-400">
                Your activity could not be loaded.
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
                {orgId ? "No audit events yet" : "No history yet"}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                Actions appear here as you use the app.
              </p>
            </TableEmptyState>
          </TableBody>
        ) : (
          <TableBody>
            {events.map((event) => {
              return (
                <TableRow
                  key={event.id}
                  role="button"
                  tabIndex={0}
                  aria-haspopup="dialog"
                  aria-label={`View details for ${event.title ?? ACTION_LABELS[event.action] ?? event.action}`}
                  className="h-auto min-h-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                  onClick={(click) => {
                    click.currentTarget.focus();
                    setSelectedEvent(event);
                  }}
                  onKeyDown={(key) => {
                    if (key.key === "Enter" || key.key === " ") {
                      key.preventDefault();
                      setSelectedEvent(event);
                    }
                  }}
                >
                  <TableStickyCell
                    widthClassName="w-52 shrink-0"
                    className="items-center"
                  >
                    <span className="min-w-0 text-xs text-gray-700 [overflow-wrap:anywhere]">
                      {event.user_display_name ?? "—"}
                    </span>
                  </TableStickyCell>
                  <TableCell className="ml-auto w-52 overflow-visible whitespace-normal py-2 pr-4 text-xs [overflow-wrap:anywhere]">
                    {event.user_email ?? "—"}
                  </TableCell>
                  <TableCell className="w-40 text-xs">
                    {formatCreatedAt(event.created_at)}
                  </TableCell>
                  <TableCell className="w-72 pr-6 text-xs text-gray-800">
                    {event.title ?? "—"}
                  </TableCell>
                  <TableCell className="w-28 text-xs">
                    <span
                      className={`inline-flex items-center gap-2 ${STATUS_TEXT_STYLES[event.status] ?? "text-gray-500"}`}
                    >
                      <span
                        aria-hidden="true"
                        data-testid={`status-dot-${event.id}`}
                        className={`${GLASS_DOT} ${STATUS_DOT_STYLES[event.status] ?? "bg-gray-400/80"}`}
                      />
                      {formatStatus(event.status)}
                    </span>
                  </TableCell>
                  <TableCell className="w-44 text-xs text-gray-700">
                    {ACTION_LABELS[event.action] ?? event.action}
                  </TableCell>
                  <TableCell className="w-32 text-xs">
                    {event.surface
                      ? (SURFACE_LABELS[event.surface] ?? event.surface)
                      : "—"}
                  </TableCell>
                  <TableCell className="w-28 pr-4 text-xs">
                    {event.model ?? "—"}
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
      {selectedEvent && (
        <HistoryEventModal
          title={title}
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
      {exportOpen && (
        <HistoryExportModal
          title={title}
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

function HistoryEventModal({
  title,
  event,
  onClose,
}: {
  title: string;
  event: AuditEvent;
  onClose: () => void;
}) {
  const href = eventHref(event);
  const fields = [
    ["Username", event.user_display_name ?? "—"],
    ["Email", event.user_email ?? "—"],
    ["Created", formatCreatedAt(event.created_at)],
    ["Status", formatStatus(event.status)],
    ["Type", ACTION_LABELS[event.action] ?? event.action],
    [
      "Application",
      event.surface ? (SURFACE_LABELS[event.surface] ?? event.surface) : "—",
    ],
    ["Model", event.model ?? "—"],
  ];
  const details = Object.entries(event.detail ?? {});

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      className="h-auto max-h-[calc(100dvh-2rem)]"
      breadcrumbs={[title, "Event details"]}
    >
      <div
        data-modal-scroll="vertical"
        className="min-h-0 overflow-y-auto pb-5"
      >
        <h2 className="mb-5 font-serif text-2xl text-gray-900 [overflow-wrap:anywhere]">
          {event.title ?? ACTION_LABELS[event.action] ?? event.action}
        </h2>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {fields.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="mb-1 text-xs text-gray-500">{label}</dt>
              <dd className="whitespace-pre-wrap text-sm text-gray-800 [overflow-wrap:anywhere]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {details.length > 0 && (
          <section className="mt-5" aria-label="Additional details">
            <h3 className="mb-3 text-sm font-medium text-gray-800">
              Additional details
            </h3>
            <dl className="space-y-3">
              {details.map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <dt className="mb-1 text-xs text-gray-500 [overflow-wrap:anywhere]">
                    {formatStatus(key)}
                  </dt>
                  <dd className="whitespace-pre-wrap text-sm text-gray-800 [overflow-wrap:anywhere]">
                    {value == null
                      ? "—"
                      : typeof value === "boolean"
                        ? value
                          ? "Yes"
                          : "No"
                        : typeof value === "object"
                          ? JSON.stringify(value, null, 2)
                          : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        {href && (
          <Link
            href={href}
            className={textButtonUIClassName({ className: "mt-5 px-0" })}
          >
            Open{" "}
            {event.chat_id ? "chat" : event.review_id ? "review" : "project"}
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    </Modal>
  );
}

function HistoryExportModal({
  title,
  from,
  to,
  exporting,
  error,
  onClose,
  onExport,
}: {
  title: string;
  from: string;
  to: string;
  exporting: boolean;
  error: boolean;
  onClose: () => void;
  onExport: (range: { from: string; to: string }) => void;
}) {
  const [range, setRange] = useState({ from, to });
  const validRange =
    range.from <= range.to && range.to <= localDateValue(new Date());

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      className="h-auto max-h-[calc(100dvh-2rem)]"
      breadcrumbs={[
        title,
        title === "History" ? "Export history" : "Export audit log",
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
          Choose the period to export. Your current search and filters will
          apply. Exports include up to 2,000 events; narrow the period for
          larger logs.
        </p>
        <fieldset disabled={exporting}>
          <HistoryDateRangeFields range={range} onChange={setRange} />
        </fieldset>
        <p className="mt-4 text-xs text-gray-500">
          {formatRangeDate(range.from)} – {formatRangeDate(range.to)}{" "}
          (inclusive)
        </p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            Your history could not be exported. Please try again.
          </p>
        )}
      </div>
    </Modal>
  );
}

function HistoryDateRangeFields({
  range,
  onChange,
}: {
  range: { from: string; to: string };
  onChange: (range: { from: string; to: string }) => void;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[14rem_14rem]">
      <HistoryDatePicker
        label="Start date"
        testId="start-date-picker"
        selected={dateFromLocalValue(range.from)}
        disabled={{ after: dateFromLocalValue(range.to) }}
        onSelect={(date) => onChange({ ...range, from: localDateValue(date) })}
      />
      <HistoryDatePicker
        label="End date"
        testId="end-date-picker"
        selected={dateFromLocalValue(range.to)}
        disabled={[
          { before: dateFromLocalValue(range.from) },
          { after: new Date() },
        ]}
        onSelect={(date) => onChange({ ...range, to: localDateValue(date) })}
      />
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
    if (!hasChanges) return;
    onChange(draftRange);
    setOpen(false);
  };

  return (
    <Dropdown open={open} onOpenChange={handleOpenChange}>
      <DropdownTrigger asChild>
        <TabPillButtonUI active aria-label="Select date range">
          <CalendarDays className="h-3.5 w-3.5" />
          {formatRangeDate(from)} – {formatRangeDate(to)}
        </TabPillButtonUI>
      </DropdownTrigger>
      <DropdownContent
        align="start"
        className="w-auto p-3"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <HistoryDateRangeFields range={draftRange} onChange={setDraftRange} />
        <div className="flex justify-end pt-3">
          <PillButtonUI
            tone="black"
            disabled={!hasChanges}
            onClick={handleConfirm}
          >
            Confirm
          </PillButtonUI>
        </div>
      </DropdownContent>
    </Dropdown>
  );
}

function HistoryDatePicker({
  label,
  testId,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  testId: string;
  selected: Date;
  disabled: Matcher | Matcher[];
  onSelect: (date: Date) => void;
}) {
  return (
    <section data-testid={testId} aria-label={label} className="w-56 min-w-0">
      <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-gray-400">
        {label}
      </p>
      <DayPicker
        mode="single"
        required
        selected={selected}
        onSelect={onSelect}
        defaultMonth={selected}
        endMonth={new Date()}
        disabled={disabled}
        showOutsideDays
        style={HISTORY_DATE_PICKER_STYLE}
        classNames={HISTORY_DATE_PICKER_CLASS_NAMES}
      />
    </section>
  );
}

const HISTORY_DATE_PICKER_STYLE = {
  "--rdp-accent-color": "#111827",
  "--rdp-accent-background-color": "#e5e7eb",
  "--rdp-day-height": "2rem",
  "--rdp-day-width": "2rem",
  "--rdp-day_button-height": "1.75rem",
  "--rdp-day_button-width": "1.75rem",
  "--rdp-day_button-border": "0 solid transparent",
  "--rdp-selected-border": "0 solid transparent",
  "--rdp-nav-height": "2rem",
  "--rdp-nav_button-height": "2rem",
  "--rdp-nav_button-width": "2rem",
  "--rdp-outside-opacity": "0.35",
} as CSSProperties;

const HISTORY_DATE_PICKER_CLASS_NAMES = {
  ...dayPickerStyles,
  root: cn(dayPickerStyles.root, "m-0 w-56 text-xs text-gray-700"),
  caption_label: cn(
    dayPickerStyles.caption_label,
    "!text-xs !font-semibold text-gray-800",
  ),
  month: "w-56",
  month_grid: cn(dayPickerStyles.month_grid, "w-56 table-fixed"),
  button_previous: cn(
    dayPickerStyles.button_previous,
    "rounded-full text-gray-500 hover:bg-white/70 hover:text-gray-900",
  ),
  button_next: cn(
    dayPickerStyles.button_next,
    "rounded-full text-gray-500 hover:bg-white/70 hover:text-gray-900",
  ),
  chevron: cn(dayPickerStyles.chevron, "h-3.5 w-3.5 fill-gray-500"),
  weekday: cn(
    dayPickerStyles.weekday,
    "!p-0 !text-[10px] !font-medium text-gray-400",
  ),
  day_button: cn(
    dayPickerStyles.day_button,
    "text-xs font-normal hover:bg-white/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500/40",
  ),
  selected: cn(
    dayPickerStyles.selected,
    "!text-xs !font-medium [&>button]:!bg-gray-200 [&>button]:!text-gray-900",
  ),
  today: cn(dayPickerStyles.today, "font-semibold text-gray-900"),
};

function HistoryLoadingRows() {
  return (
    <TableBody>
      {[1, 2, 3, 4, 5].map((row) => (
        <TableRow key={row} interactive={false} className="h-auto min-h-10">
          <TableStickyCell
            widthClassName="w-52 shrink-0"
            className="items-center"
          >
            <SkeletonLine className="w-32" />
          </TableStickyCell>
          <TableCell className="ml-auto w-52">
            <SkeletonLine className="w-36" />
          </TableCell>
          <TableCell className="w-40">
            <SkeletonLine className="w-24" />
          </TableCell>
          <TableCell className="w-72">
            <SkeletonLine className="w-44" />
          </TableCell>
          <TableCell className="w-28">
            <SkeletonLine className="w-16" />
          </TableCell>
          <TableCell className="w-44">
            <SkeletonLine className="w-24" />
          </TableCell>
          <TableCell className="w-32">
            <SkeletonLine className="w-20" />
          </TableCell>
          <TableCell className="w-28 pr-4">
            <SkeletonLine className="w-24" />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  );
}

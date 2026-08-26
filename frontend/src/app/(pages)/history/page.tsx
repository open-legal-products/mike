"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { CalendarDays, Download, Loader2 } from "lucide-react";
import { DayPicker, type Matcher } from "@daypicker/react";
import dayPickerStyles from "@daypicker/react/style.module.css";
import { getAuditHistory, type AuditEvent } from "@/app/lib/mikeApi";
import { runUserExport } from "@/app/lib/asyncExport";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  type TableFilterOption,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  type TableSortDirection,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { HistorySkeuoIcon } from "@/app/components/shared/HistorySkeuoIcon";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { LiquidDropdownContent } from "@/app/components/ui/liquid-dropdown";
import { cn } from "@/app/lib/utils";

const ACTION_LABELS: Record<string, string> = {
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
  "h-2.5 w-2.5 shrink-0 rounded-full border border-white/80 shadow-[0_1px_2px_rgba(15,23,42,0.08),inset_0_1px_1px_rgba(255,255,255,0.55)] backdrop-blur-xl";

const SURFACE_LABELS: Record<string, string> = {
  assistant: "Assistant",
  project: "Project",
  word: "Word",
  tabular: "Tabular",
  workflows: "Workflows",
  account: "Account",
};

const SORT_OPTIONS: TableFilterOption<TableSortDirection>[] = [
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
];

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

export default function HistoryPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
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
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
      try {
        const out = await getAuditHistory(
          {
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
          append ? [...current, ...out.events] : out.events,
        );
        setTotal(out.total);
        setPage(nextPage);
      } catch {
        if (controller.signal.aborted) return;
        if (!append) {
          setEvents([]);
          setTotal(0);
        }
        setError(true);
      } finally {
        if (controllerRef.current === controller) setLoading(false);
      }
    },
    [action, debouncedSearch, from, sort, status, surface, to],
  );

  useEffect(() => {
    void load(1, false);
    return () => controllerRef.current?.abort();
  }, [load]);

  // The CSV is built by a background job rather than in the request: a wide
  // filter can sweep thousands of events, and the artifact outlives the tab.
  const handleExport = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await runUserExport("audit-csv", {
        q: search.trim() || undefined,
        action: action || undefined,
        status: status || undefined,
        surface: surface || undefined,
        from: from || undefined,
        to: to || undefined,
        sort_by: sort?.key,
        sort_dir: sort?.direction,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename ?? "history-export.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed.");
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
        actions={[
          {
            type: "search",
            value: search,
            onChange: setSearch,
            placeholder: "Search history…",
          },
          {
            icon: exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            ),
            label: "Export",
            title: "Export history",
            disabled: exporting,
            onClick: () => void handleExport(),
          },
        ]}
      >
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          History
        </h1>
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
                <TableFilters
                  label="Sort by email"
                  value={sortValue("user_email")}
                  allLabel="Default Order"
                  widthClassName="w-40"
                  align="right"
                  options={SORT_OPTIONS}
                  onChange={(direction) =>
                    setSortDirection("user_email", direction)
                  }
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-40">
              <span className="mr-1">Created</span>
              {!initialLoading && (
                <TableFilters
                  label="Sort by created date"
                  value={sortValue("created_at")}
                  allLabel="Default Order"
                  options={SORT_OPTIONS}
                  onChange={(direction) =>
                    setSortDirection("created_at", direction)
                  }
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell className="w-72">
              <span className="mr-1">Title</span>
              {!initialLoading && (
                <TableFilters
                  label="Sort by title"
                  value={sortValue("title")}
                  allLabel="Default Order"
                  options={SORT_OPTIONS}
                  onChange={(direction) => setSortDirection("title", direction)}
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
                <TableFilters
                  label="Sort by model"
                  value={sortValue("model")}
                  allLabel="Default Order"
                  options={SORT_OPTIONS}
                  onChange={(direction) => setSortDirection("model", direction)}
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
                History unavailable
              </p>
              <p className="mt-1 text-xs text-gray-400">
                Your activity could not be loaded.
              </p>
              <PillButton
                tone="white"
                className="mt-4"
                onClick={() => void load(1, false)}
              >
                Try again
              </PillButton>
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
                No history yet
              </p>
              <p className="mt-1 text-xs text-gray-400">
                Actions appear here as you use the app.
              </p>
            </TableEmptyState>
          </TableBody>
        ) : (
          <TableBody>
            {events.map((event) => {
              const href = eventHref(event);
              return (
                <TableRow key={event.id} interactive={false}>
                  <TableStickyCell
                    widthClassName="w-52 shrink-0"
                    className="items-center"
                  >
                    <span className="min-w-0 truncate text-xs text-gray-700">
                      {event.user_display_name ?? "—"}
                    </span>
                  </TableStickyCell>
                  <TableCell className="ml-auto w-52 text-xs">
                    {event.user_email ?? "—"}
                  </TableCell>
                  <TableCell className="w-40 text-xs">
                    {formatCreatedAt(event.created_at)}
                  </TableCell>
                  <TableCell className="w-72 pr-6 text-xs text-gray-800">
                    {href ? (
                      <Link href={href} className="hover:underline">
                        {event.title ?? "—"}
                      </Link>
                    ) : (
                      (event.title ?? "—")
                    )}
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
            {loading && (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
              </div>
            )}
            {!loading && events.length < total && (
              <div className="flex justify-center py-3">
                <PillButton
                  tone="white"
                  onClick={() => void load(page + 1, true)}
                >
                  Load more ({events.length} of {total})
                </PillButton>
              </div>
            )}
          </TableBody>
        )}
      </TableScrollArea>
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
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <TabPillButton active aria-label="Select date range">
          <CalendarDays className="h-3.5 w-3.5" />
          {formatRangeDate(from)} – {formatRangeDate(to)}
        </TabPillButton>
      </DropdownMenuTrigger>
      <LiquidDropdownContent
        align="start"
        className="z-[130] w-auto p-3"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[14rem_14rem]">
          <HistoryDatePicker
            label="Start date"
            testId="start-date-picker"
            selected={dateFromLocalValue(draftRange.from)}
            disabled={{ after: dateFromLocalValue(draftRange.to) }}
            onSelect={(date) =>
              setDraftRange((current) => ({
                ...current,
                from: localDateValue(date),
              }))
            }
          />
          <HistoryDatePicker
            label="End date"
            testId="end-date-picker"
            selected={dateFromLocalValue(draftRange.to)}
            disabled={[
              { before: dateFromLocalValue(draftRange.from) },
              { after: new Date() },
            ]}
            onSelect={(date) =>
              setDraftRange((current) => ({
                ...current,
                to: localDateValue(date),
              }))
            }
          />
        </div>
        <div className="flex justify-end pt-3">
          <PillButton
            tone="black"
            disabled={!hasChanges}
            onClick={handleConfirm}
          >
            Confirm
          </PillButton>
        </div>
      </LiquidDropdownContent>
    </DropdownMenu>
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
    "text-xs font-normal hover:bg-white/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gray-400",
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
        <TableRow key={row} interactive={false}>
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

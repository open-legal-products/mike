"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Eye,
  Info,
  Loader2,
  Play,
  Trash2,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { RowActions } from "@/app/components/shared/RowActions";
import { DropdownItem } from "@/shared/ui/dropdown";
import { AccessScopeLabel } from "@/app/components/shared/AccessScopeLabel";
import {
  CreatorLabel,
  CreatorLabelSkeleton,
} from "@/app/components/shared/CreatorLabel";
import {
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
  type TableFilterOption,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import type { ResourceAccessScope } from "@/app/components/shared/types";
import type { Playbook, PlaybookImport } from "@/app/lib/mikeApi";

const NAME_COLUMN = "flex min-w-64 flex-1 items-center pl-3 pr-4";
const CREATOR_COLUMN = "w-36 shrink-0 pr-4";
const ACCESS_COLUMN = "w-32 shrink-0 pr-4";
const TYPE_COLUMN = "w-36 shrink-0 pr-4";
const REPRESENTED_COLUMN = "w-36 shrink-0 pr-4";
const JURISDICTION_COLUMN = "w-40 shrink-0 pr-4";
const RULES_COLUMN = "w-16 shrink-0";
const UPDATED_COLUMN = "w-28 shrink-0";
const ACTIONS_COLUMN = "w-8 shrink-0 justify-end";
const DETAIL_TEXT = "truncate text-xs text-gray-600";
const NAME_LINK_CLASS =
  "flex w-full min-w-0 items-center rounded text-left text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40";

/** Each playbook has its own page, so it can be linked, refreshed and shared. */
export function playbookPath(id: string) {
  return `/playbooks/${id}`;
}
const TABLE_MIN_WIDTH = "min-w-[76rem]";

// Matches the Access column of Workflows: only owners see who a personal
// playbook is shared with, so anyone else it reaches sees "Private (Shared)".
export function accessScope(playbook: Playbook): ResourceAccessScope {
  if (playbook.visibility === "organization") return "organization";
  if (playbook.sharedWith.length > 0 || !playbook.isCreator) return "shared";
  return "private";
}

// Public: open to the whole organization. Private: everything else, whether
// it is its creator's alone or shared with individuals.
type AccessFilter = "public" | "private";
const ACCESS_FILTER_OPTIONS: TableFilterOption<AccessFilter>[] = [
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
];

type Filters = {
  creator: string | null;
  access: AccessFilter | null;
  type: string | null;
  represented: string | null;
  jurisdiction: string | null;
};
const NO_FILTERS: Filters = {
  creator: null,
  access: null,
  type: null,
  represented: null,
  jurisdiction: null,
};

function creatorLabel(playbook: Playbook) {
  return playbook.isCreator ? "Me" : playbook.creatorName?.trim() || "Unknown";
}

function listText(values: string[]) {
  return values.join(", ");
}

function filterOptions(values: string[]): TableFilterOption<string>[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, label: value }));
}

/** A filter whose value has left the list stops applying. */
function available(value: string | null, options: TableFilterOption<string>[]) {
  return value && options.some((option) => option.value === value)
    ? value
    : null;
}

export type PlaybookActionHandlers = {
  onOpen: (id: string) => void;
  onDetails: (id: string) => void;
  onRun: (id: string) => void;
  onPeople: (playbook: Playbook) => void;
  onDelete: (id: string) => void;
  /** Deletes every selected playbook, after confirmation. */
  onDeleteSelected: () => void;
};

type MenuAction = {
  label: string;
  icon: LucideIcon;
  run: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

/**
 * The one playbook menu: the row button, the row's context menu, and the
 * toolbar's Actions menu all render it, so they always offer the same actions.
 * `playbooks` are the rows it acts on; `onDeselect` is given when they are the
 * current selection.
 */
export function PlaybookActionItems({
  playbooks,
  disabled,
  onActionChosen,
  onDeselect,
  onOpen,
  onDetails,
  onRun,
  onPeople,
  onDelete,
  onDeleteSelected,
}: PlaybookActionHandlers & {
  playbooks: Playbook[];
  disabled: boolean;
  onActionChosen: () => void;
  onDeselect?: () => void;
}) {
  const [playbook] = playbooks;
  const actions: MenuAction[] = [
    ...(onDeselect
      ? [{ label: "Deselect rows", icon: X, run: onDeselect }]
      : []),
    ...(playbooks.length > 1
      ? [
          {
            label: `Delete ${playbooks.length} playbooks`,
            icon: Trash2,
            run: onDeleteSelected,
            destructive: true,
            disabled: playbooks.some((item) => !item.canManageAccess),
          },
        ]
      : playbook
        ? [
            { label: "Open", icon: Eye, run: () => onOpen(playbook.id) },
            {
              label: "Details",
              icon: Info,
              run: () => onDetails(playbook.id),
            },
            { label: "Run", icon: Play, run: () => onRun(playbook.id) },
            { label: "People", icon: Users, run: () => onPeople(playbook) },
            {
              label: "Delete",
              icon: Trash2,
              run: () => onDelete(playbook.id),
              destructive: true,
              disabled: !playbook.canManageAccess,
            },
          ]
        : []),
  ];
  return actions.map((action) => (
    <DropdownItem
      key={action.label}
      disabled={disabled || action.disabled}
      variant={action.destructive ? "destructive" : "default"}
      onPointerUp={(event) => {
        // A context menu may open beneath the pointer before the right
        // button is released; that release must not choose an action.
        if (event.button !== 0) event.preventDefault();
      }}
      onSelect={() => {
        onActionChosen();
        action.run();
      }}
    >
      <action.icon aria-hidden="true" className="h-3.5 w-3.5" />
      {action.label}
    </DropdownItem>
  ));
}

export function PlaybookTable({
  playbooks,
  loading,
  error,
  filtered,
  emptyContext = "mine",
  disabled,
  onOpen,
  onDetails,
  onRun,
  onPeople,
  onDelete,
  onDeleteSelected,
  selectedIds,
  onSelect,
  onRetry,
  onImport,
  onCreate,
  compiling = [],
  showNewImports = true,
}: PlaybookActionHandlers & {
  playbooks: Playbook[];
  loading: boolean;
  error: string | null;
  filtered: boolean;
  emptyContext?: "all" | "mine" | "shared" | "private" | "public";
  disabled: boolean;
  selectedIds: Set<string>;
  onSelect: (ids: Set<string>) => void;
  onRetry: () => void;
  onImport: () => void;
  onCreate: () => void;
  /** Imports compiling on the server, drawn as loading rows. */
  compiling?: PlaybookImport[];
  /** A new import becomes the caller's own private playbook. */
  showNewImports?: boolean;
}) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  const options = useMemo(() => {
    const creators = new Map<string, string>();
    for (const playbook of playbooks)
      creators.set(playbook.userId, creatorLabel(playbook));
    return {
      creator: [...creators]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) =>
          a.label === "Me"
            ? -1
            : b.label === "Me"
              ? 1
              : a.label.localeCompare(b.label),
        ),
      type: filterOptions(
        playbooks.flatMap((playbook) => playbook.content.documentTypes),
      ),
      represented: filterOptions(
        playbooks.map((playbook) => playbook.content.representedParty),
      ),
      jurisdiction: filterOptions(
        playbooks.flatMap((playbook) => playbook.content.jurisdictions),
      ),
    };
  }, [playbooks]);

  // Switching tabs or deleting a playbook can remove a filtered value; the
  // filter then stops applying instead of hiding every row.
  const active: Filters = {
    creator: available(filters.creator, options.creator),
    access: filters.access,
    type: available(filters.type, options.type),
    represented: available(filters.represented, options.represented),
    jurisdiction: available(filters.jurisdiction, options.jurisdiction),
  };

  const displayed = playbooks.filter(
    (playbook) =>
      (!active.creator || playbook.userId === active.creator) &&
      (!active.access ||
        (active.access === "public") ===
          (playbook.visibility === "organization")) &&
      (!active.type ||
        playbook.content.documentTypes.some(
          (value) => value.trim() === active.type,
        )) &&
      (!active.represented ||
        playbook.content.representedParty.trim() === active.represented) &&
      (!active.jurisdiction ||
        playbook.content.jurisdictions.some(
          (value) => value.trim() === active.jurisdiction,
        )),
  );

  function changeFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
    onSelect(new Set());
  }

  // A replacement compiles into its playbook's row; a new import has a row of
  // its own until its playbook arrives.
  const replacing = new Set(
    compiling.flatMap((attempt) =>
      attempt.playbookId ? [attempt.playbookId] : [],
    ),
  );
  const newImports = showNewImports
    ? compiling.filter(
        (attempt) =>
          !attempt.playbookId ||
          !playbooks.some((playbook) => playbook.id === attempt.playbookId),
      )
    : [];

  const showFilters = !loading && !error && playbooks.length > 0;

  // A selected row's menu acts on the whole selection, like the toolbar's.
  function renderActions(playbook: Playbook, onActionChosen: () => void) {
    const inSelection = selectedIds.has(playbook.id);
    return (
      <PlaybookActionItems
        playbooks={
          inSelection
            ? displayed.filter((item) => selectedIds.has(item.id))
            : [playbook]
        }
        disabled={disabled}
        onActionChosen={onActionChosen}
        onDeselect={inSelection ? () => onSelect(new Set()) : undefined}
        onOpen={onOpen}
        onDetails={onDetails}
        onRun={onRun}
        onPeople={onPeople}
        onDelete={onDelete}
        onDeleteSelected={onDeleteSelected}
      />
    );
  }

  return (
    <TableScrollArea>
      <div
        role="table"
        aria-label="Playbooks"
        aria-busy={loading}
        className="flex min-h-full min-w-0 flex-col"
      >
        <div
          role="rowgroup"
          className={`table-sticky-header sticky top-0 z-[70] ${TABLE_MIN_WIDTH}`}
        >
          <TableHeaderRow role="row" className="min-w-0">
            <TableHeaderCell role="columnheader" className={NAME_COLUMN}>
              <input
                type="checkbox"
                aria-label="Select all playbooks"
                className={TABLE_CHECKBOX_CLASS}
                disabled={loading || disabled || !displayed.length}
                checked={
                  displayed.length > 0 &&
                  displayed.every((item) => selectedIds.has(item.id))
                }
                ref={(node) => {
                  if (node)
                    node.indeterminate =
                      displayed.some((item) => selectedIds.has(item.id)) &&
                      !displayed.every((item) => selectedIds.has(item.id));
                }}
                onChange={(event) =>
                  onSelect(
                    event.target.checked
                      ? new Set(displayed.map((item) => item.id))
                      : new Set(),
                  )
                }
              />
              Name
            </TableHeaderCell>
            <TableHeaderCell
              role="columnheader"
              className={`${CREATOR_COLUMN} gap-1`}
            >
              <span>Creator</span>
              {showFilters && (
                <TableFilters
                  label="Filter by creator"
                  value={active.creator}
                  allLabel="All Creators"
                  widthClassName="w-48"
                  options={options.creator}
                  onChange={(value) => changeFilter("creator", value)}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell
              role="columnheader"
              className={`${ACCESS_COLUMN} gap-1`}
            >
              <span>Access</span>
              {showFilters && (
                <TableFilters
                  label="Filter by access"
                  value={active.access}
                  allLabel="All Access"
                  widthClassName="w-40"
                  options={ACCESS_FILTER_OPTIONS}
                  onChange={(value) => changeFilter("access", value)}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell
              role="columnheader"
              className={`${TYPE_COLUMN} gap-1`}
            >
              <span>Type</span>
              {showFilters && (
                <TableFilters
                  label="Filter by document type"
                  value={active.type}
                  allLabel="All Types"
                  widthClassName="w-48"
                  options={options.type}
                  onChange={(value) => changeFilter("type", value)}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell
              role="columnheader"
              className={`${REPRESENTED_COLUMN} gap-1`}
            >
              <span>Represented</span>
              {showFilters && (
                <TableFilters
                  label="Filter by represented party"
                  value={active.represented}
                  allLabel="All Parties"
                  widthClassName="w-48"
                  options={options.represented}
                  onChange={(value) => changeFilter("represented", value)}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell
              role="columnheader"
              className={`${JURISDICTION_COLUMN} gap-1`}
            >
              <span>Jurisdiction</span>
              {showFilters && (
                <TableFilters
                  label="Filter by jurisdiction"
                  value={active.jurisdiction}
                  allLabel="All Jurisdictions"
                  widthClassName="w-52"
                  options={options.jurisdiction}
                  onChange={(value) => changeFilter("jurisdiction", value)}
                />
              )}
            </TableHeaderCell>
            <TableHeaderCell role="columnheader" className={RULES_COLUMN}>
              Rules
            </TableHeaderCell>
            <TableHeaderCell role="columnheader" className={UPDATED_COLUMN}>
              Updated
            </TableHeaderCell>
            <TableHeaderCell role="columnheader" className={ACTIONS_COLUMN}>
              <span className="sr-only">Actions</span>
            </TableHeaderCell>
          </TableHeaderRow>
        </div>
        {loading ? (
          <TableBody role="rowgroup" className={TABLE_MIN_WIDTH}>
            {Array.from({ length: 6 }, (_, index) => (
              <TableRow
                key={index}
                role="row"
                className="min-w-0"
                interactive={false}
              >
                <TableCell role="cell" className={NAME_COLUMN}>
                  <span className="mr-3 h-2.5 w-2.5 shrink-0 rounded bg-gray-200 animate-pulse" />
                  <SkeletonLine className="w-44" />
                </TableCell>
                <TableCell role="cell" className={CREATOR_COLUMN}>
                  <CreatorLabelSkeleton className="w-16" />
                </TableCell>
                <TableCell role="cell" className={ACCESS_COLUMN}>
                  <SkeletonLine className="w-14" />
                </TableCell>
                <TableCell role="cell" className={TYPE_COLUMN}>
                  <SkeletonLine className="w-16" />
                </TableCell>
                <TableCell role="cell" className={REPRESENTED_COLUMN}>
                  <SkeletonLine className="w-16" />
                </TableCell>
                <TableCell role="cell" className={JURISDICTION_COLUMN}>
                  <SkeletonLine className="w-20" />
                </TableCell>
                <TableCell role="cell" className={RULES_COLUMN}>
                  <SkeletonLine className="w-6" />
                </TableCell>
                <TableCell role="cell" className={UPDATED_COLUMN}>
                  <SkeletonLine className="w-20" />
                </TableCell>
                <TableCell role="cell" className={ACTIONS_COLUMN}>
                  <SkeletonLine className="w-4" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        ) : error ? (
          <TableEmptyState>
            <EmptyState
              tone="error"
              title="Couldn’t load playbooks"
              description={error}
              action={
                <PillButtonUI tone="white" onClick={onRetry}>
                  Try again
                </PillButtonUI>
              }
            />
          </TableEmptyState>
        ) : playbooks.length === 0 && newImports.length === 0 ? (
          <TableEmptyState>
            <EmptyState
              title={
                filtered
                  ? "No matching playbooks"
                  : emptyContext === "shared"
                    ? "No shared playbooks"
                    : emptyContext === "public"
                      ? "No public playbooks"
                      : "No playbooks yet"
              }
              description={
                filtered
                  ? "Try another name or description."
                  : emptyContext === "shared"
                    ? "Playbooks shared with your email address will appear here."
                    : emptyContext === "public"
                      ? "Playbooks made public to this workspace will appear here."
                      : "Turn a Word negotiation guide into rules, or write your own."
              }
              action={
                !filtered &&
                emptyContext !== "shared" && (
                  <div className="flex items-center gap-2">
                    <PillButtonUI
                      tone="black"
                      onClick={onImport}
                      disabled={disabled}
                    >
                      Import
                    </PillButtonUI>
                    <PillButtonUI
                      tone="white"
                      onClick={onCreate}
                      disabled={disabled}
                    >
                      Create
                    </PillButtonUI>
                  </div>
                )
              }
            />
          </TableEmptyState>
        ) : displayed.length === 0 && newImports.length === 0 ? (
          <TableEmptyState>
            <EmptyState
              title="No matching playbooks"
              description="Adjust the table filters to see more playbooks."
              action={
                <PillButtonUI
                  tone="white"
                  onClick={() => {
                    setFilters(NO_FILTERS);
                    onSelect(new Set());
                  }}
                >
                  Clear filters
                </PillButtonUI>
              }
            />
          </TableEmptyState>
        ) : (
          <TableBody role="rowgroup" className={TABLE_MIN_WIDTH}>
            {newImports.map((attempt) => {
              const name =
                attempt.name?.trim() ||
                attempt.filename.replace(/\.(docx|pdf)$/i, "") ||
                "Imported playbook";
              return (
                <TableRow
                  key={`import:${attempt.id}`}
                  role="row"
                  aria-busy="true"
                  className="min-w-0"
                  interactive={false}
                >
                  <TableCell role="cell" className={NAME_COLUMN}>
                    {/* In the checkbox's place: nothing to select yet. */}
                    <Loader2
                      aria-hidden="true"
                      className="mr-3 h-2.5 w-2.5 shrink-0 animate-spin text-gray-400 motion-reduce:animate-none"
                    />
                    <span className="min-w-0 truncate text-gray-500" title={name}>
                      <span className="sr-only">Compiling </span>
                      {name}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-gray-400" aria-hidden="true">
                      Compiling…
                    </span>
                  </TableCell>
                  <TableCell role="cell" className={CREATOR_COLUMN}>
                    <SkeletonLine className="w-16" />
                  </TableCell>
                  <TableCell role="cell" className={ACCESS_COLUMN}>
                    <SkeletonLine className="w-14" />
                  </TableCell>
                  <TableCell role="cell" className={TYPE_COLUMN}>
                    <SkeletonLine className="w-16" />
                  </TableCell>
                  <TableCell role="cell" className={REPRESENTED_COLUMN}>
                    <SkeletonLine className="w-16" />
                  </TableCell>
                  <TableCell role="cell" className={JURISDICTION_COLUMN}>
                    <SkeletonLine className="w-20" />
                  </TableCell>
                  <TableCell role="cell" className={RULES_COLUMN}>
                    <SkeletonLine className="w-6" />
                  </TableCell>
                  <TableCell role="cell" className={UPDATED_COLUMN}>
                    <SkeletonLine className="w-20" />
                  </TableCell>
                  <TableCell role="cell" className={ACTIONS_COLUMN} />
                </TableRow>
              );
            })}
            {displayed.map((playbook) => (
              <TableRow
                key={playbook.id}
                role="row"
                className="min-w-0"
                selected={selectedIds.has(playbook.id)}
                aria-selected={selectedIds.has(playbook.id)}
                interactive={!disabled}
                rightClickDropdown={
                  disabled
                    ? undefined
                    : (close) => renderActions(playbook, close)
                }
                onClick={() => {
                  if (!disabled) onOpen(playbook.id);
                }}
              >
                <TableCell role="cell" className={NAME_COLUMN}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${playbook.name}`}
                    className={TABLE_CHECKBOX_CLASS}
                    disabled={disabled}
                    checked={selectedIds.has(playbook.id)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const next = new Set(selectedIds);
                      if (event.target.checked) next.add(playbook.id);
                      else next.delete(playbook.id);
                      onSelect(next);
                    }}
                  />
                  {disabled ? (
                    <span className={NAME_LINK_CLASS} title={playbook.name}>
                      <span className="truncate">{playbook.name}</span>
                    </span>
                  ) : (
                    <Link
                      href={playbookPath(playbook.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        // A modified click opens a new tab; a plain one opens
                        // the playbook here, through the host.
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        onOpen(playbook.id);
                      }}
                      className={NAME_LINK_CLASS}
                      title={playbook.name}
                    >
                      <span className="truncate">{playbook.name}</span>
                    </Link>
                  )}
                  {replacing.has(playbook.id) && (
                    <span
                      role="status"
                      className="ml-2 flex shrink-0 items-center gap-1 text-xs text-gray-400"
                    >
                      <Loader2
                        aria-hidden="true"
                        className="h-3 w-3 animate-spin motion-reduce:animate-none"
                      />
                      Compiling…
                    </span>
                  )}
                </TableCell>
                <TableCell role="cell" className={CREATOR_COLUMN}>
                  <CreatorLabel
                    label={creatorLabel(playbook)}
                    photo={playbook.creatorPhoto}
                    name={playbook.creatorName}
                  />
                </TableCell>
                <TableCell role="cell" className={ACCESS_COLUMN}>
                  <AccessScopeLabel
                    scope={accessScope(playbook)}
                    directGrantCount={
                      playbook.canManageAccess
                        ? playbook.sharedWith.length
                        : undefined
                    }
                  />
                </TableCell>
                <TableCell
                  role="cell"
                  className={`${TYPE_COLUMN} ${DETAIL_TEXT}`}
                  title={listText(playbook.content.documentTypes) || undefined}
                >
                  {listText(playbook.content.documentTypes) || "—"}
                </TableCell>
                <TableCell
                  role="cell"
                  className={`${REPRESENTED_COLUMN} ${DETAIL_TEXT}`}
                  title={playbook.content.representedParty || undefined}
                >
                  {playbook.content.representedParty || "—"}
                </TableCell>
                <TableCell
                  role="cell"
                  className={`${JURISDICTION_COLUMN} ${DETAIL_TEXT}`}
                  title={listText(playbook.content.jurisdictions) || undefined}
                >
                  {listText(playbook.content.jurisdictions) || "—"}
                </TableCell>
                <TableCell role="cell" className={RULES_COLUMN}>
                  {playbook.content.topics.reduce(
                    (sum, topic) => sum + topic.rules.length,
                    playbook.content.rules?.length ?? 0,
                  )}
                </TableCell>
                <TableCell role="cell" className={UPDATED_COLUMN}>
                  <time dateTime={playbook.updatedAt}>
                    {new Date(playbook.updatedAt).toLocaleDateString(
                      undefined,
                      { month: "short", day: "numeric", year: "numeric" },
                    )}
                  </time>
                </TableCell>
                <TableCell role="cell" className={ACTIONS_COLUMN}>
                  {disabled ? (
                    <span
                      aria-hidden="true"
                      className="flex h-6 w-6 items-center justify-center text-xs text-gray-400"
                    >
                      ···
                    </span>
                  ) : (
                    <RowActions
                      ariaLabel={`Actions for ${playbook.name}`}
                      renderItems={(onActionChosen) =>
                        renderActions(playbook, onActionChosen)
                      }
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        )}
      </div>
    </TableScrollArea>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Trash2,
  UserRound,
  UserRoundCheck,
} from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import {
  ChatSkeuoIcon,
  LibrarySkeuoIcon,
  OrganizationSkeuoIcon,
  TabularReviewSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import {
  ClosedProjectSvgIcon,
  ProjectSvgIcon,
} from "@/app/components/shared/FolderSvgIcon";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { SelectionActionsMenu } from "@/app/components/shared/SelectionActionsMenu";
import {
  SkeletonCheckbox,
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { LIQUID_GLASS_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import {
  deleteOrgDepartureArchives,
  isMfaRequiredError,
  listOrgDepartures,
  reassignOrgDepartureArchives,
  type OrgDeparture,
  type OrgDepartureItem,
  type OrgDepartureList,
  type OrgMember,
} from "@/app/lib/mikeApi";
import { notifySuccess, userFacingApiError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import { DropdownItem } from "@/shared/ui/dropdown";

type Kind = OrgDepartureItem["kind"];

/** The types of work, in the order a departure lists them. */
const KIND_GROUPS: { kind: Kind; label: string; one: string; many: string }[] =
  [
    { kind: "project", label: "Projects", one: "project", many: "projects" },
    {
      kind: "workflow",
      label: "Workflows",
      one: "workflow",
      many: "workflows",
    },
    { kind: "chat", label: "Chats", one: "chat", many: "chats" },
    {
      kind: "tabular_review",
      label: "Tabular reviews",
      one: "tabular review",
      many: "tabular reviews",
    },
    {
      kind: "document",
      label: "Library files",
      one: "library file",
      many: "library files",
    },
  ];

/** A deadline this close is drawn in the warning colour. */
const SOON_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What an action is about to be applied to, and how to name it. */
interface Target {
  ids: string[];
  label: string;
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The date, and how far off it is. */
function deadline(expiresAt: string, now: number) {
  const days = Math.ceil((new Date(expiresAt).getTime() - now) / DAY_MS);
  const distance =
    days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return {
    text: `${formatDate(expiresAt)} · ${distance}`,
    soon: days <= SOON_DAYS,
  };
}

/** What a project or workflow holds; nothing for the other kinds. */
function contentsLabel(item: OrgDepartureItem) {
  if (!item.contents) return "";
  const parts = [
    item.contents.documents > 0 && count(item.contents.documents, "document"),
    item.contents.chats > 0 && count(item.contents.chats, "chat"),
    item.contents.tabular_reviews > 0 &&
      count(item.contents.tabular_reviews, "review"),
  ].filter(Boolean);
  if (parts.length) return parts.join(", ");
  // A workflow with no files of its own still has its steps.
  return item.kind === "project" ? "Empty" : "";
}

/** A deleted account leaves no name behind. */
const departedName = (departure: OrgDeparture) =>
  departure.member?.display_name ||
  departure.member?.email ||
  "Former member";

const ICON_CLASS = "mr-2 h-4 w-4 shrink-0";

/**
 * The name cell's tree. Every checkbox stays in the one column at the left
 * edge; only what follows it steps in, by the width of a chevron and its
 * gap, so a row's icon sits under its parent's.
 */
const LABEL_INDENT_CLASS = ["", "pl-6", "pl-12"] as const;

/** The icon each type of work has elsewhere in the app. */
function KindIcon({
  kind,
  filename,
  open = false,
}: {
  kind: Kind;
  /** A library file's own name picks its file-type icon. */
  filename?: string;
  /** A type's row opens like a folder. */
  open?: boolean;
}) {
  if (kind === "project")
    return filename === undefined ? (
      <ProjectSvgIcon open={open} className={ICON_CLASS} />
    ) : (
      <ClosedProjectSvgIcon className={ICON_CLASS} />
    );
  if (kind === "workflow") return <WorkflowSkeuoIcon className={ICON_CLASS} />;
  if (kind === "chat") return <ChatSkeuoIcon className={ICON_CLASS} />;
  if (kind === "tabular_review")
    return <TabularReviewSkeuoIcon className={ICON_CLASS} />;
  return filename === undefined ? (
    <LibrarySkeuoIcon className={ICON_CLASS} />
  ) : (
    <FileTypeIcon fileType={filename} className={ICON_CLASS} />
  );
}

const CHEVRON_BUTTON_CLASS =
  "mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40";

/**
 * The Departed view of an organization's Members page: the private work its
 * former members left, held for 30 days, for an owner to hand to somebody or
 * delete. Only owners are shown it, and the API checks that for itself.
 *
 * One row per departure, with the person, when they left and when their work
 * is deleted. It starts closed, and opens into the types of work and then the
 * items, so an owner can hand over everything at once or pick it apart. Selection is
 * always of items: selecting a person or a type selects what is under it.
 *
 * `renderToolbar` draws the page's tabs, so this view's selection actions sit
 * beside them as the roster's do.
 */
export function OrganizationDepartedMembers({
  orgId,
  members,
  search,
  renderToolbar,
}: {
  orgId: string;
  /** The roster, to choose a new owner from. */
  members: OrgMember[];
  /** Narrows the list to people or items whose name contains it. */
  search: string;
  renderToolbar: (actions?: ReactNode) => ReactNode;
}) {
  const [list, setList] = useState<OrgDepartureList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Every row starts closed: a departure opens into its types of work, and
  // a type into its items.
  const [openDepartures, setOpenDepartures] = useState<Set<string>>(
    new Set(),
  );
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reassigning, setReassigning] = useState<Target | null>(null);
  const [successor, setSuccessor] = useState("");
  const [deleting, setDeleting] = useState<Target | null>(null);
  const [mfaTarget, setMfaTarget] = useState<Target | null>(null);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Fixed for the visit, so a row's "in 12 days" does not change under it.
  const [now] = useState(() => Date.now());
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++requestRef.current;
    try {
      const next = await listOrgDepartures(orgId);
      if (ticket !== requestRef.current) return;
      setList(next);
      setLoadError(null);
    } catch (error) {
      if (ticket !== requestRef.current) return;
      setLoadError(
        userFacingApiError(error, "Could not load departed members."),
      );
    }
  }, [orgId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const query = search.trim().toLowerCase();
  const departures = useMemo(() => {
    const all = list?.departures ?? [];
    if (!query) return all;
    return all.flatMap((departure) => {
      const who =
        `${departure.member?.display_name ?? ""} ${departure.member?.email ?? ""}`.toLowerCase();
      if (who.includes(query)) return [departure];
      const items = departure.items.filter((item) =>
        item.title.toLowerCase().includes(query),
      );
      return items.length ? [{ ...departure, items }] : [];
    });
  }, [list, query]);

  // What is selected and still on screen: a search or a reload can take
  // items away, and an action must never reach one that is out of sight.
  const visibleIds = useMemo(
    () => departures.flatMap((departure) => departure.items.map((i) => i.id)),
    [departures],
  );
  const selected = useMemo(
    () => selectedIds.filter((id) => visibleIds.includes(id)),
    [selectedIds, visibleIds],
  );
  const isSelected = (ids: string[]) =>
    ids.length > 0 && ids.every((id) => selected.includes(id));
  const isPartlySelected = (ids: string[]) =>
    !isSelected(ids) && ids.some((id) => selected.includes(id));

  function toggle(ids: string[]) {
    setSelectedIds(
      isSelected(ids)
        ? selected.filter((id) => !ids.includes(id))
        : [...new Set([...selected, ...ids])],
    );
  }

  function toggleIn(
    setKeys: (update: (current: Set<string>) => Set<string>) => void,
    key: string,
  ) {
    setKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** A row inside a larger selection speaks for the whole selection. */
  function actionTarget(target: Target): Target {
    return selected.length > target.ids.length && isSelected(target.ids)
      ? {
          ids: selected,
          label: `the ${count(selected.length, "selected item")}`,
        }
      : target;
  }

  function openReassign(target: Target) {
    setFailure(null);
    setSuccessor(
      members.find((member) => member.role === "owner")?.user_id ?? "",
    );
    setReassigning(target);
  }

  function openDelete(target: Target) {
    setFailure(null);
    setDeleting(target);
  }

  async function reassign() {
    if (!reassigning || !successor) return;
    setWorking(true);
    try {
      const result = await reassignOrgDepartureArchives(
        orgId,
        reassigning.ids,
        successor,
      );
      const owner = members.find((member) => member.user_id === successor);
      setReassigning(null);
      setSelectedIds([]);
      if (result.unresolved > 0)
        setFailure(
          `${count(result.unresolved, "item")} could not be reassigned: the recovery period has ended, or the member is no longer in the organization.`,
        );
      else
        notifySuccess(
          `Reassigned to ${owner?.display_name || owner?.email || "the selected member"}.`,
        );
      await load();
    } catch (error) {
      setFailure(userFacingApiError(error, "Could not reassign this work."));
    } finally {
      setWorking(false);
    }
  }

  async function remove(target: Target) {
    setWorking(true);
    try {
      const result = await deleteOrgDepartureArchives(orgId, target.ids);
      setDeleting(null);
      setSelectedIds([]);
      if (result.unresolved > 0)
        setFailure(
          `${count(result.unresolved, "item")} could not be deleted. Try again.`,
        );
      else notifySuccess("Archived work deleted.");
      await load();
    } catch (error) {
      setDeleting(null);
      if (isMfaRequiredError(error)) setMfaTarget(target);
      else setFailure(userFacingApiError(error, "Could not delete this work."));
    } finally {
      setWorking(false);
    }
  }

  /** The same two actions for a row's menu, its right-click and the toolbar. */
  function renderMenuItems(target: Target, close?: () => void) {
    const acting = actionTarget(target);
    const onSelection = acting !== target;
    return (
      <>
        <DropdownItem
          onSelect={() => {
            close?.();
            openReassign(acting);
          }}
        >
          <UserRoundCheck className="h-3.5 w-3.5" />
          {onSelection ? "Reassign selected…" : "Reassign…"}
        </DropdownItem>
        <DropdownItem
          variant="destructive"
          onSelect={() => {
            close?.();
            openDelete(acting);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {onSelection ? "Delete selected" : "Delete"}
        </DropdownItem>
      </>
    );
  }

  const rowMenu = (target: Target, title: string) => (
    <HeaderActionsMenu
      title={title}
      items={[
        {
          label: "Reassign…",
          icon: UserRoundCheck,
          onSelect: () => openReassign(target),
        },
        {
          label: "Delete",
          icon: Trash2,
          variant: "danger",
          onSelect: () => openDelete(target),
        },
      ]}
    />
  );

  const checkbox = (ids: string[], label: string) => (
    <input
      type="checkbox"
      checked={isSelected(ids)}
      ref={(element) => {
        if (element) element.indeterminate = isPartlySelected(ids);
      }}
      onChange={() => toggle(ids)}
      onClick={(event) => event.stopPropagation()}
      className={TABLE_CHECKBOX_CLASS}
      title={label}
      aria-label={label}
    />
  );

  const loading = list === null && loadError === null;

  return (
    <>
      {renderToolbar(
        selected.length > 0 ? (
          <SelectionActionsMenu
            renderItems={(close) =>
              renderMenuItems(
                {
                  ids: selected,
                  label: `the ${count(selected.length, "selected item")}`,
                },
                close,
              )
            }
          />
        ) : undefined,
      )}

      <TableScrollArea
        header={
          <TableHeaderRow>
            <TableStickyCell header>
              {loading ? (
                <SkeletonCheckbox />
              ) : (
                checkbox(visibleIds, "Select all archived work")
              )}
              <span className="mr-1">
                Name
                {list && !loadError ? (
                  <>
                    {" "}
                    <span className="font-normal text-gray-400">
                      ({departures.length})
                    </span>
                  </>
                ) : null}
              </span>
            </TableStickyCell>
            <TableHeaderCell className="ml-auto w-64">Email</TableHeaderCell>
            <TableHeaderCell className="w-56">Contents</TableHeaderCell>
            <TableHeaderCell className="w-32">Left</TableHeaderCell>
            <TableHeaderCell className="w-48">Deletes</TableHeaderCell>
            <TableHeaderCell className="w-10" />
          </TableHeaderRow>
        }
      >
        {loading ? (
          <TableBody>
            {[1, 2, 3].map((row) => (
              <TableRow key={row} interactive={false}>
                <TableStickyCell hover={false} bgClassName="bg-transparent">
                  <SkeletonCheckbox />
                  <SkeletonLine className="w-40" />
                </TableStickyCell>
                {["w-64", "w-56", "w-32", "w-48", "w-10"].map(
                  (width, index) => (
                    <TableCell
                      key={width}
                      className={cn(index === 0 && "ml-auto", width)}
                    >
                      {width === "w-10" ? null : (
                        <SkeletonLine className="w-20" />
                      )}
                    </TableCell>
                  ),
                )}
              </TableRow>
            ))}
          </TableBody>
        ) : list === null ? (
          <TableEmptyState>
            <EmptyState
              icon={<OrganizationSkeuoIcon />}
              title="Departed members"
              description={loadError}
              tone="error"
              action={
                <button
                  type="button"
                  onClick={() => {
                    setLoadError(null);
                    void load();
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                  <Loader2 className="h-3.5 w-3.5" />
                  Try again
                </button>
              }
            />
          </TableEmptyState>
        ) : list.departures.length === 0 ? (
          <TableEmptyState>
            <EmptyState
              icon={<OrganizationSkeuoIcon />}
              title="Departed members"
              description="No work is waiting for a decision. Private work a member leaves behind is kept here for 30 days, then permanently deleted."
            />
          </TableEmptyState>
        ) : departures.length === 0 ? (
          <TableEmptyState>
            <p className="text-sm text-gray-400">
              No departed members or archived work match this search.
            </p>
          </TableEmptyState>
        ) : (
          <TableBody>
            {departures.map((departure) => {
              const name = departedName(departure);
              const possessive = departure.member
                ? `${name}'s`
                : "this former member's";
              const ids = departure.items.map((item) => item.id);
              const target: Target = {
                ids,
                label: departure.member
                  ? `everything ${name} left`
                  : "everything this former member left",
              };
              // A search opens what it found, so a match is never hidden
              // inside a closed row.
              const open = !!query || openDepartures.has(departure.key);
              const due = deadline(departure.expires_at, now);
              const everySelected = isSelected(ids);
              return [
                <TableRow
                  key={departure.key}
                  interactive={false}
                  selected={everySelected}
                  aria-expanded={open}
                  rightClickDropdown={(close) => renderMenuItems(target, close)}
                  className={
                    !everySelected ? LIQUID_GLASS_HOVER_CLASS : undefined
                  }
                >
                  <TablePrimaryCell
                    selected={everySelected}
                    onSelectionChange={() => toggle(ids)}
                    selectionIndicator={checkbox(
                      ids,
                      `Select everything ${name} left`,
                    )}
                    label={
                      <span className="flex min-w-0 items-center">
                        <button
                          type="button"
                          aria-label={
                            open ? `Collapse ${name}` : `Expand ${name}`
                          }
                          onClick={() =>
                            toggleIn(setOpenDepartures, departure.key)
                          }
                          className={CHEVRON_BUTTON_CLASS}
                        >
                          {open ? (
                            <ChevronDown className="h-4 w-4 text-gray-400" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-gray-400" />
                          )}
                        </button>
                        <UserRound
                          aria-hidden="true"
                          className={cn(ICON_CLASS, "text-gray-500")}
                        />
                        <span className="truncate text-xs font-medium text-gray-800">
                          {name}
                        </span>
                      </span>
                    }
                  />
                  <TableCell className="ml-auto w-64">
                    {departure.member
                      ? departure.member.email || "—"
                      : "Account deleted"}
                  </TableCell>
                  <TableCell className="w-56">
                    {count(departure.items.length, "item")}
                  </TableCell>
                  <TableCell className="w-32">
                    {formatDate(departure.departed_at)}
                  </TableCell>
                  <TableCell
                    className={cn("w-48", due.soon && "text-red-600")}
                  >
                    {due.text}
                  </TableCell>
                  <TableCell className="flex w-10 justify-end overflow-visible">
                    {rowMenu(target, `Actions for ${name}`)}
                  </TableCell>
                </TableRow>,
                ...(open
                  ? KIND_GROUPS.flatMap((group) => {
                      const items = departure.items.filter(
                        (item) => item.kind === group.kind,
                      );
                      if (!items.length) return [];
                      const groupKey = `${departure.key}|${group.kind}`;
                      const groupIds = items.map((item) => item.id);
                      const groupTarget: Target = {
                        ids: groupIds,
                        label: `${possessive} ${count(items.length, group.one, group.many)}`,
                      };
                      const groupOpen = !!query || openGroups.has(groupKey);
                      const groupSelected = isSelected(groupIds);
                      const groupName = `${possessive} ${group.many}`;
                      return [
                        <TableRow
                          key={groupKey}
                          interactive={false}
                          selected={groupSelected}
                          aria-expanded={groupOpen}
                          rightClickDropdown={(close) =>
                            renderMenuItems(groupTarget, close)
                          }
                          className={
                            !groupSelected
                              ? LIQUID_GLASS_HOVER_CLASS
                              : undefined
                          }
                        >
                          <TablePrimaryCell
                            selected={groupSelected}
                            onSelectionChange={() => toggle(groupIds)}
                            selectionIndicator={checkbox(
                              groupIds,
                              `Select ${groupName}`,
                            )}
                            label={
                              <span
                                className={cn(
                                  "flex min-w-0 items-center",
                                  LABEL_INDENT_CLASS[1],
                                )}
                              >
                                <button
                                  type="button"
                                  aria-label={
                                    groupOpen
                                      ? `Collapse ${groupName}`
                                      : `Expand ${groupName}`
                                  }
                                  onClick={() =>
                                    toggleIn(setOpenGroups, groupKey)
                                  }
                                  className={CHEVRON_BUTTON_CLASS}
                                >
                                  {groupOpen ? (
                                    <ChevronDown className="h-4 w-4 text-gray-400" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4 text-gray-400" />
                                  )}
                                </button>
                                <KindIcon kind={group.kind} open={groupOpen} />
                                <span className="truncate text-xs text-gray-700">
                                  {group.label}{" "}
                                  <span className="text-gray-400">
                                    ({items.length})
                                  </span>
                                </span>
                              </span>
                            }
                          />
                          <TableCell className="ml-auto w-64" />
                          <TableCell className="w-56" />
                          <TableCell className="w-32" />
                          <TableCell className="w-48" />
                          <TableCell className="flex w-10 justify-end overflow-visible">
                            {rowMenu(groupTarget, `Actions for ${groupName}`)}
                          </TableCell>
                        </TableRow>,
                        ...(groupOpen
                          ? items.map((item) => {
                              const itemTarget: Target = {
                                ids: [item.id],
                                label: item.title,
                              };
                              const itemSelected = selected.includes(item.id);
                              return (
                                <TableRow
                                  key={item.id}
                                  interactive={false}
                                  selected={itemSelected}
                                  rightClickDropdown={(close) =>
                                    renderMenuItems(itemTarget, close)
                                  }
                                  className={
                                    !itemSelected
                                      ? LIQUID_GLASS_HOVER_CLASS
                                      : undefined
                                  }
                                >
                                  <TablePrimaryCell
                                    label={
                                      <span
                                        className={cn(
                                          "flex min-w-0 items-center",
                                          LABEL_INDENT_CLASS[2],
                                        )}
                                      >
                                        <KindIcon
                                          kind={item.kind}
                                          filename={item.title}
                                        />
                                        <span className="truncate">
                                          {item.title}
                                        </span>
                                      </span>
                                    }
                                    selected={itemSelected}
                                    onSelectionChange={() => toggle([item.id])}
                                    checkboxTitle={`Select ${item.title}`}
                                  />
                                  <TableCell className="ml-auto w-64" />
                                  <TableCell className="w-56">
                                    {contentsLabel(item)}
                                  </TableCell>
                                  <TableCell className="w-32" />
                                  <TableCell className="w-48" />
                                  <TableCell className="flex w-10 justify-end overflow-visible">
                                    {rowMenu(
                                      itemTarget,
                                      `Actions for ${item.title}`,
                                    )}
                                  </TableCell>
                                </TableRow>
                              );
                            })
                          : []),
                      ];
                    })
                  : []),
              ];
            })}
            {list.truncated ? (
              <p className="px-3 py-3 text-xs text-gray-400">
                Only the work that is deleted soonest is listed. The rest
                appears as this is reassigned or deleted.
              </p>
            ) : null}
          </TableBody>
        )}
      </TableScrollArea>

      <Modal
        open={reassigning !== null}
        onClose={() => {
          if (!working) setReassigning(null);
        }}
        breadcrumbs={["Organization", "Departed members", "Reassign"]}
        size="sm"
        cancelAction={{
          label: "Cancel",
          disabled: working,
          onClick: () => setReassigning(null),
        }}
        primaryAction={{
          label: working ? "Reassigning..." : "Reassign",
          disabled: working || !successor,
          onClick: () => void reassign(),
        }}
      >
        <div className="space-y-4 pb-4">
          <p className="text-sm text-gray-700 [overflow-wrap:anywhere]">
            Choose who takes over {reassigning?.label}. Projects and workflows
            keep their contents, and the work stays private to its new owner.
          </p>
          <ModalSelect
            id="departed-work-owner"
            aria-label="Reassign to"
            value={successor}
            onChange={setSuccessor}
            wrapLabels
            disabled={working}
            options={members.map((member) => ({
              value: member.user_id,
              label: member.display_name || member.email || "Unnamed member",
              suffix:
                member.display_name && member.email
                  ? `(${member.email})`
                  : undefined,
            }))}
          />
        </div>
      </Modal>
      <ConfirmPopup
        open={deleting !== null}
        title="Delete archived work?"
        message={`Permanently delete ${deleting?.label ?? "this work"}, with its contents? This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={working ? "loading" : "idle"}
        onCancel={() => {
          if (!working) setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
      />
      <MfaVerificationPopup
        open={mfaTarget !== null}
        onCancel={() => setMfaTarget(null)}
        onVerified={() => {
          const target = mfaTarget;
          setMfaTarget(null);
          if (target) void remove(target);
        }}
      />
      <WarningPopup
        open={failure !== null || (loadError !== null && list !== null)}
        title={
          failure !== null
            ? "Archived work not changed"
            : "Archived work not refreshed"
        }
        message={failure ?? loadError}
        onClose={() => {
          setFailure(null);
          setLoadError(null);
        }}
      />
    </>
  );
}

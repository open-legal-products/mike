"use client";

import { UserAvatar } from "@/app/components/ui/user-avatar";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Check, ChevronDown, Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { SelectionActionsMenu } from "@/app/components/shared/SelectionActionsMenu";
import {
  SkeletonCheckbox,
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
  TableBody,
  TableCell,
  TableEmptyState,
  TableSortFilter,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
  type TableFilterOption,
  type TableSortDirection,
} from "@/app/components/shared/TablePrimitive";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  MemberDepartureDialog,
  type MemberDepartureResult,
} from "./MemberDepartureDialog";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { EmptyState } from "@/app/components/ui/empty-state";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { LIQUID_GLASS_HOVER_CLASS } from "@/app/components/ui/liquid-surface";
import {
  getOrg,
  listOrgInvitations,
  listOrgMembers,
  updateOrgMember,
  type Org,
  type OrgInvitation,
  type OrgMember,
} from "@/app/lib/mikeApi";
import {
  ORG_ROLE_LABELS,
  ORG_ROLES,
  canManageOrgRole,
  isOrgAdmin,
  type OrgRole,
} from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { OrganizationDepartedMembers } from "./OrganizationDepartedMembers";
import { InviteOrganizationMemberModal } from "./OrganizationModals";

/** The roster's fixed order: who decides, who runs it, everybody else. */
const ROLE_ORDER: Record<OrgRole, number> = { owner: 0, admin: 1, member: 2 };

/** Rows drawn per page, as in the app's other paginated tables. */
const MEMBERS_PAGE_SIZE = 30;

/** Where somebody lands once they have left the organization. */
const AFTER_DEPARTURE = "/settings/organizations";

// Role colours follow the project access editor: blue for the top role,
// violet for the middle one, grey for the base one. Amber is the app's
// caution colour, so no role uses it.
const ROLE_FILTER_OPTIONS: TableFilterOption<OrgRole>[] = [
  { value: "owner", label: ORG_ROLE_LABELS.owner, className: "text-blue-700" },
  {
    value: "admin",
    label: ORG_ROLE_LABELS.admin,
    className: "text-violet-700",
  },
  {
    value: "member",
    label: ORG_ROLE_LABELS.member,
    className: "text-gray-600",
  },
];

/**
 * The page's tabs: everyone, the people holding one role, or — for the
 * organization's owners — the people who have left and the work they left.
 */
type RosterTab = "all" | OrgRole | "departed";

const ROSTER_TABS: { id: RosterTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "owner", label: "Owners" },
  { id: "admin", label: "Admins" },
  { id: "member", label: "Members" },
];
const OWNER_TABS: { id: RosterTab; label: string }[] = [
  ...ROSTER_TABS,
  { id: "departed", label: "Departed" },
];

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The Members page of an organization's settings: its roster, each
 * person's role, and — for its owners and admins — adding, removing and
 * inviting people. Everyone in the organization can read it.
 *
 * A table page like the app's others, with search and the add button in the
 * page header, rather than a section inside the settings frame: a roster
 * needs the width, and it is where an organization's admins spend their
 * time. The header's first crumb leads back to the other sections.
 *
 * It loads the organization itself, so the roster and the caller's role on
 * it always come from the same read. `onViewerRoleChanged` tells the
 * surrounding settings area when the caller has changed their own role,
 * which decides the sections it offers.
 */
export function OrganizationMembers({
  orgId,
  onViewerRoleChanged,
  initialTab = "all",
}: {
  orgId: string;
  onViewerRoleChanged?: () => void;
  /** Opens on the Departed view, for a link that leads straight to it. */
  initialTab?: "all" | "departed";
}) {
  const router = useRouter();
  const { user } = useAuth();
  const { refreshOrganizations } = useWorkspace();
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [rosterTab, setRosterTab] = useState<RosterTab>(initialTab);
  const [removeSelectedOpen, setRemoveSelectedOpen] = useState(false);
  const [removeMember, setRemoveMember] = useState<OrgMember | null>(null);
  const [pendingSelfRoleChange, setPendingSelfRoleChange] = useState<{
    member: OrgMember;
    role: OrgRole;
  } | null>(null);

  /**
   * Which read of each list is the current one.
   *
   * Two independent readers write these lists — the full `load` and the
   * `refreshPeople` that runs whenever the Add-member modal opens or closes —
   * and nothing ordered them. Opening the modal on a still-loading page fires
   * both, and whichever response arrives LAST wins regardless of which was
   * asked first: a three-person roster was seen collapsing to one, because
   * the older answer landed second. Every read takes a ticket and applies its
   * result only while that ticket is still the newest, so a slow answer to an
   * old question is discarded instead of overwriting a newer one.
   */
  const membersRequestRef = useRef(0);
  const invitationsRequestRef = useRef(0);

  /**
   * `member_count` is derived from the roster, so it moves with it or not at
   * all — writing the count from a read whose rows were discarded would put
   * the header and the table into two different truths.
   */
  const applyMembers = useCallback((ticket: number, next: OrgMember[]) => {
    if (ticket !== membersRequestRef.current) return;
    setMembers(next);
    setOrg((current) =>
      current ? { ...current, member_count: next.length } : current,
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const membersTicket = ++membersRequestRef.current;
    const invitationsTicket = ++invitationsRequestRef.current;
    try {
      const nextOrg = await getOrg(orgId);
      const [nextMembers, nextInvitations] = await Promise.all([
        listOrgMembers(orgId),
        isOrgAdmin(nextOrg.role)
          ? listOrgInvitations(orgId)
          : Promise.resolve([] as OrgInvitation[]),
      ]);
      setOrg(nextOrg);
      applyMembers(membersTicket, nextMembers);
      if (invitationsTicket === invitationsRequestRef.current)
        setInvitations(nextInvitations);
    } catch (error) {
      console.error("Failed to load organization", error);
      setLoadError(
        userFacingApiError(error, "Could not load this organization."),
      );
    } finally {
      setLoading(false);
    }
  }, [applyMembers, orgId]);

  const refreshInvitations = useCallback(async () => {
    if (!isOrgAdmin(org?.role)) return;
    const ticket = ++invitationsRequestRef.current;
    const nextInvitations = await listOrgInvitations(orgId);
    if (ticket !== invitationsRequestRef.current) return;
    setInvitations(nextInvitations);
  }, [org?.role, orgId]);

  const refreshMembers = useCallback(async () => {
    const ticket = ++membersRequestRef.current;
    applyMembers(ticket, await listOrgMembers(orgId));
  }, [applyMembers, orgId]);

  /**
   * An invitation is accepted somewhere else entirely — in the recipient's
   * browser — so nothing on this page hears about it. Both lists it lands in
   * therefore have to be re-read together whenever the admin looks: the
   * invitation leaves "Pending invitations" and the same person appears on the
   * People roster. Reading only the invitations, which is what the Add member
   * modal used to do, left the roster a reload behind.
   *
   * One failing does not cancel the other — but neither is it swallowed. A
   * console line is not a user interface: the admin was left reading a roster
   * that had silently stopped tracking the server, with the page looking
   * exactly as it does when the refresh worked. It says so now, in the same
   * place every other failed action on this page speaks.
   */
  const refreshPeople = useCallback(async () => {
    const results = await Promise.allSettled([
      refreshInvitations(),
      refreshMembers(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (!failure) return;
    console.error("Failed to refresh organization people", failure.reason);
    setActionError(
      userFacingApiError(
        failure.reason,
        "This organization's people could not be refreshed. Reload to see the current list.",
      ),
    );
  }, [refreshInvitations, refreshMembers]);

  useEffect(() => {
    void load();
  }, [load]);

  const viewerRole = org?.role ?? null;
  const isAdmin = isOrgAdmin(viewerRole);
  // The Departed view is its owners' alone: nobody else is offered the tab,
  // and a link to it opens the roster for them.
  const tabs = viewerRole === "owner" ? OWNER_TABS : ROSTER_TABS;
  const tab = rosterTab === "departed" && viewerRole !== "owner" ? "all" : rosterTab;
  const changeTab = (next: RosterTab) => {
    setRosterTab(next);
    // A selection made under one tab does not carry into another, where
    // some of it would be out of sight.
    setSelectedMemberIds([]);
  };

  /**
   * Mirrors the server: the viewer must outrank both the role the member
   * holds and the one they would be given, owners excepted. Offering a change
   * the server refuses only ever produced a 403.
   */
  function canChangeRole(member: OrgMember, role: OrgRole) {
    return (
      canManageOrgRole(viewerRole, member.role) &&
      canManageOrgRole(viewerRole, role)
    );
  }

  /** Leaving is always allowed; removing somebody else needs standing. */
  function canRemove(member: OrgMember) {
    return (
      member.user_id === user?.id || canManageOrgRole(viewerRole, member.role)
    );
  }

  /**
   * Demoting yourself is the one role change that rewrites what this page is
   * allowed to do, so it is confirmed before it runs rather than silently
   * pulling the controls out from under the click.
   */
  function requestRoleChange(member: OrgMember, role: OrgRole) {
    if (!canChangeRole(member, role) || member.role === role || busyMemberId)
      return;
    if (member.user_id === user?.id) {
      setPendingSelfRoleChange({ member, role });
      return;
    }
    void changeRole(member, role);
  }

  async function changeRole(member: OrgMember, role: OrgRole) {
    if (!canChangeRole(member, role) || member.role === role || busyMemberId)
      return;
    setBusyMemberId(member.user_id);
    setActionError(null);
    try {
      await updateOrgMember(orgId, member.user_id, role);
      setMembers((current) =>
        current.map((row) =>
          row.user_id === member.user_id ? { ...row, role } : row,
        ),
      );
      // The membership row is not the only place this role lives: `org.role`
      // gates every owner- and admin-only control and request on the page.
      // Without this the demoted person keeps a UI they no longer have rights
      // for, and each action 403s until a reload.
      if (member.user_id === user?.id) {
        setOrg((current) => (current ? { ...current, role } : current));
        if (!isOrgAdmin(role)) setInvitations([]);
        // The settings area offers different sections to a different role,
        // and the workspace switcher shows it too.
        onViewerRoleChanged?.();
        void refreshOrganizations();
      }
    } catch (error) {
      setActionError(userFacingApiError(error, "Could not change that role."));
    } finally {
      setBusyMemberId(null);
    }
  }

  // The dialog has done the removing (and the handing over); this is what
  // the page does about it.
  function finishRemoveMember(result: MemberDepartureResult) {
    const member = removeMember;
    setRemoveMember(null);
    if (!member) return;
    if (!result.removedUserIds.includes(member.user_id)) {
      setActionError(
        userFacingApiError(result.error, "Could not remove that member."),
      );
      return;
    }
    if (member.user_id === user?.id) {
      void refreshOrganizations();
      router.push(AFTER_DEPARTURE);
      return;
    }
    setMembers((current) =>
      current.filter((row) => row.user_id !== member.user_id),
    );
    setSelectedMemberIds((current) =>
      current.filter((id) => id !== member.id),
    );
  }

  function requestRemoveSelected() {
    if (!isAdmin || selectedMemberIds.length === 0) return;
    const selectedMembers = members.filter((member) =>
      selectedMemberIds.includes(member.id),
    );
    if (selectedMembers.some((member) => member.user_id === user?.id)) {
      setActionError("Use Leave organization to remove yourself.");
      return;
    }
    if (
      selectedMembers.some(
        (member) => !canManageOrgRole(viewerRole, member.role),
      )
    ) {
      setActionError(
        "Only an organization owner can remove admins and other owners.",
      );
      return;
    }
    setRemoveSelectedOpen(true);
  }

  function finishRemoveSelected(result: MemberDepartureResult) {
    const removedIds = members
      .filter((member) => result.removedUserIds.includes(member.user_id))
      .map((member) => member.id);
    setMembers((current) =>
      current.filter((member) => !removedIds.includes(member.id)),
    );
    setSelectedMemberIds((current) =>
      current.filter((id) => !removedIds.includes(id)),
    );
    if (result.error) {
      setActionError(
        userFacingApiError(
          result.error,
          "Could not remove all selected members.",
        ),
      );
    }
    setRemoveSelectedOpen(false);
  }

  function renderMemberActions(
    member: OrgMember | undefined,
    close?: () => void,
  ) {
    const appliesToSelection =
      member &&
      selectedMemberIds.includes(member.id) &&
      selectedMemberIds.length > 1 &&
      isAdmin;
    if (!appliesToSelection && (!member || !canRemove(member))) return null;
    return (
      <DropdownItem
        variant="destructive"
        onSelect={() => {
          close?.();
          if (appliesToSelection) requestRemoveSelected();
          else if (member) setRemoveMember(member);
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {appliesToSelection
          ? "Remove all selected"
          : member?.user_id === user?.id
            ? "Leave organization"
            : "Remove member"}
      </DropdownItem>
    );
  }

  const selectionActions =
    isAdmin && selectedMemberIds.length > 0 ? (
      <SelectionActionsMenu renderItems={(close) => renderMemberActions(members.find((member) => member.id === selectedMemberIds[0]), close)} />
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        breadcrumbs={[
          {
            label: "Organization",
            onClick: () => router.push(`/organizations/${orgId}/settings`),
            title: "Back to Organization",
          },
          { label: "Members", cursor: "text" },
        ]}
        actions={[
          {
            type: "search",
            value: search,
            onChange: (value) => {
              setSearch(value);
              // A selection made in one result set does not carry into
              // another, where some of it would be out of sight.
              setSelectedMemberIds([]);
            },
            placeholder:
              tab === "departed" ? "Search departed members…" : "Search members…",
          },
          {
            type: "new",
            title: isAdmin
              ? "Add member"
              : "Only organization admins can add members",
            disabled: !isAdmin,
            onClick: () => {
              setInviteOpen(true);
              // The modal shows the invitation list this page loaded, which
              // by now may name people who have already accepted.
              void refreshPeople();
            },
          },
        ]}
      />

      {tab === "departed" ? (
        <OrganizationDepartedMembers
          orgId={orgId}
          members={members}
          search={search}
          renderToolbar={(actions) => (
            <TableToolbar
              items={tabs}
              active={tab}
              onChange={changeTab}
              actions={actions}
            />
          )}
        />
      ) : (
        <>
          <TableToolbar
            items={tabs}
            active={tab}
            onChange={changeTab}
            actions={selectionActions ?? undefined}
          />

          <PeopleTable
            loading={loading}
            error={loadError}
            members={members}
            search={search}
            roleFilter={tab === "all" ? null : tab}
            selectedMemberIds={selectedMemberIds}
            onSelectedMemberIdsChange={setSelectedMemberIds}
            currentUserId={user?.id ?? null}
            viewerRole={viewerRole}
            busyMemberId={busyMemberId}
            onRetry={load}
            onRoleChange={requestRoleChange}
            onRemove={setRemoveMember}
            renderActions={renderMemberActions}
          />
        </>
      )}

      {org ? (
        <>
          <InviteOrganizationMemberModal
            open={inviteOpen}
            org={org}
            invitations={invitations}
            onClose={() => {
              setInviteOpen(false);
              // An invitation sent or accepted while the modal was open
              // changes BOTH lists behind it — a new invitation is pending, an
              // accepted one is gone and its sender is now on the roster — so
              // the admin returns to a re-read of both, not of the roster
              // alone with a stale "Pending invitations" beside it.
              void refreshPeople();
            }}
            onChanged={refreshPeople}
          />
        </>
      ) : null}

      {removeMember ? (
        <MemberDepartureDialog
          orgId={orgId}
          departing={[removeMember]}
          leaving={removeMember.user_id === user?.id}
          members={members}
          onCancel={() => setRemoveMember(null)}
          onDone={finishRemoveMember}
        />
      ) : null}
      <ConfirmPopup
        open={pendingSelfRoleChange !== null}
        title={
          pendingSelfRoleChange?.role === "admin"
            ? "Step down to admin?"
            : "Give up owner access?"
        }
        message={
          pendingSelfRoleChange?.role === "admin"
            ? "You will stay an admin, but can no longer delete this organization or appoint and remove its admins and owners."
            : "You will lose owner access to this organization and can no longer manage its people, settings or invitations."
        }
        confirmLabel="Continue"
        confirmStatus={busyMemberId ? "loading" : "idle"}
        onCancel={() => {
          if (busyMemberId) return;
          setPendingSelfRoleChange(null);
        }}
        onConfirm={() => {
          const pending = pendingSelfRoleChange;
          if (!pending) return;
          // Closing first meant the request ran behind a popup that was
          // already gone, so the "Continuing..." state this popup is given
          // could never appear and the click looked like it did nothing.
          // Stay up, busy, until the role change settles.
          void changeRole(pending.member, pending.role).finally(() =>
            setPendingSelfRoleChange(null),
          );
        }}
      />
      {removeSelectedOpen ? (
        <MemberDepartureDialog
          orgId={orgId}
          departing={members.filter((member) =>
            selectedMemberIds.includes(member.id),
          )}
          members={members}
          onCancel={() => setRemoveSelectedOpen(false)}
          onDone={finishRemoveSelected}
        />
      ) : null}
      <WarningPopup
        open={actionError !== null}
        title="Organization action failed"
        message={actionError}
        onClose={() => setActionError(null)}
      />
    </div>
  );
}

/** Renders searchable, sortable organization members with compact avatars and permission-aware actions. */
function PeopleTable({
  loading,
  error,
  members,
  search,
  roleFilter,
  selectedMemberIds,
  onSelectedMemberIdsChange,
  currentUserId,
  viewerRole,
  busyMemberId,
  onRetry,
  onRoleChange,
  onRemove,
  renderActions,
}: {
  loading: boolean;
  error: string | null;
  members: OrgMember[];
  /** Narrows the roster to people whose name or email contains it. */
  search: string;
  /** The role the open tab shows, or null for everyone. */
  roleFilter: OrgRole | null;
  selectedMemberIds: string[];
  onSelectedMemberIdsChange: Dispatch<SetStateAction<string[]>>;
  currentUserId: string | null;
  /** The viewer's own organization role; null while it is still loading. */
  viewerRole: OrgRole | null;
  busyMemberId: string | null;
  onRetry: () => Promise<void>;
  onRoleChange: (member: OrgMember, role: OrgRole) => void;
  onRemove: (member: OrgMember) => void;
  renderActions: (member: OrgMember, close?: () => void) => ReactNode;
}) {
  const [sort, setSort] = useState<{
    key: "name" | "email" | "added";
    direction: TableSortDirection;
  } | null>(null);
  const visibleMembers = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = members.filter(
      (member) =>
        (!roleFilter || member.role === roleFilter) &&
        (!query ||
          (member.display_name ?? "").toLowerCase().includes(query) ||
          (member.email ?? "").toLowerCase().includes(query)),
    );
    // Owners, then admins, then members — always. A column sort orders the
    // people within each of those; with none chosen they are listed by name.
    const key = sort?.key ?? "name";
    const multiplier = sort?.direction === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const byRole = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
      if (byRole !== 0) return byRole;
      if (key === "added") {
        return (
          (new Date(a.created_at ?? 0).getTime() -
            new Date(b.created_at ?? 0).getTime()) *
          multiplier
        );
      }
      const aValue =
        key === "email"
          ? (a.email ?? "")
          : a.display_name || a.email || a.user_id;
      const bValue =
        key === "email"
          ? (b.email ?? "")
          : b.display_name || b.email || b.user_id;
      return aValue.localeCompare(bValue) * multiplier;
    });
  }, [members, roleFilter, search, sort]);

  // Rows are drawn a page at a time, and more as the list is scrolled, like
  // the app's other tables. The roster is already in hand, so "loading" the
  // next page is only a matter of drawing it. A different search, filter or
  // sort is a different list and starts again from its first page.
  const listKey = `${search}|${roleFilter ?? ""}|${sort?.key ?? ""}|${sort?.direction ?? ""}`;
  const [page, setPage] = useState({ listKey, count: MEMBERS_PAGE_SIZE });
  if (page.listKey !== listKey)
    setPage({ listKey, count: MEMBERS_PAGE_SIZE });
  const shownMembers = visibleMembers.slice(0, page.count);
  const hasMoreMembers = shownMembers.length < visibleMembers.length;
  const showMoreMembers = () =>
    setPage((current) => ({
      ...current,
      count: current.count + MEMBERS_PAGE_SIZE,
    }));
  const allSelected =
    visibleMembers.length > 0 &&
    visibleMembers.every((member) => selectedMemberIds.includes(member.id));
  const someSelected =
    !allSelected &&
    visibleMembers.some((member) => selectedMemberIds.includes(member.id));

  function setSortFor(
    key: "name" | "email" | "added",
    direction: TableSortDirection | null,
  ) {
    setSort(direction ? { key, direction } : null);
    onSelectedMemberIdsChange([]);
  }

  function toggleAllVisible() {
    const visibleIds = visibleMembers.map((member) => member.id);
    onSelectedMemberIdsChange((current) =>
      allSelected
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])],
    );
  }

  function toggleMember(memberId: string) {
    onSelectedMemberIdsChange((current) =>
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId],
    );
  }

  return (
    <TableScrollArea
      header={
        <TableHeaderRow>
          <TableStickyCell header>
            {loading ? (
              <SkeletonCheckbox />
            ) : (
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = someSelected;
                }}
                onChange={toggleAllVisible}
                className={TABLE_CHECKBOX_CLASS}
                aria-label="Select all people"
              />
            )}
            {/* How many people the open tab and the search come to, drawn
                or not. Plain text beside the column's name. */}
            <span className="mr-1">
              Name
              {!loading && !error ? (
                <>
                  {" "}
                  <span className="font-normal text-gray-400">
                    ({visibleMembers.length})
                  </span>
                </>
              ) : null}
            </span>
            {!loading ? (
              <TableSortFilter
                label="Sort by name"
                value={sort?.key === "name" ? sort.direction : null}
                allLabel="Default order"
                align="right"
                onChange={(direction) => setSortFor("name", direction)}
              />
            ) : null}
          </TableStickyCell>
          <TableHeaderCell className="ml-auto w-64">
            <span className="mr-1">Email</span>
            {!loading ? (
              <TableSortFilter
                label="Sort by email"
                value={sort?.key === "email" ? sort.direction : null}
                allLabel="Default order"
                onChange={(direction) => setSortFor("email", direction)}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-32">
            <span className="mr-1">Role</span>
          </TableHeaderCell>
          <TableHeaderCell className="w-36">
            <span className="mr-1">Added</span>
            {!loading ? (
              <TableSortFilter
                label="Sort by date added"
                value={sort?.key === "added" ? sort.direction : null}
                allLabel="Default order"
                onChange={(direction) => setSortFor("added", direction)}
              />
            ) : null}
          </TableHeaderCell>
          <TableHeaderCell className="w-10" />
        </TableHeaderRow>
      }
    >
      {loading ? (
        <LoadingRows columns={["w-64", "w-32", "w-36", "w-10"]} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : members.length === 0 ? (
        <TableEmptyState>
          <EmptyState
            icon={<OrganizationSkeuoIcon />}
            title="People"
            description="This organization has no members."
          />
        </TableEmptyState>
      ) : visibleMembers.length === 0 ? (
        <TableEmptyState>
          <p className="text-sm text-gray-400">
            {search.trim()
              ? "No people match this search."
              : `This organization has no ${
                  roleFilter === "owner"
                    ? "owners"
                    : roleFilter === "admin"
                      ? "admins"
                      : "ordinary members"
                }.`}
          </p>
        </TableEmptyState>
      ) : (
        <TableBody>
          {shownMembers.map((member) => {
            const label = member.display_name || member.email || member.user_id;
            const canRemove =
              member.user_id === currentUserId ||
              canManageOrgRole(viewerRole, member.role);
            // The roles the viewer may hand this member. With one or none
            // there is nothing to choose, so the role renders as plain text
            // instead of a menu that could only fail.
            const assignableRoles = canManageOrgRole(viewerRole, member.role)
              ? ORG_ROLES.filter((role) => canManageOrgRole(viewerRole, role))
              : [];
            const isSelected = selectedMemberIds.includes(member.id);
            return (
              <TableRow
                key={member.id}
                interactive={false}
                selected={isSelected}
                rightClickDropdown={(close) => renderActions(member, close)}
                className={!isSelected ? LIQUID_GLASS_HOVER_CLASS : undefined}
              >
                <TablePrimaryCell
                  selected={isSelected}
                  onSelectionChange={() => toggleMember(member.id)}
                  checkboxTitle={`Select ${label}`}
                >
                  <UserAvatar photo={member.profile_photo} name={member.display_name} email={member.email} size="sm" className="mr-2" />
                  <span className="min-w-0 flex-1 text-xs text-gray-800 [overflow-wrap:anywhere]">
                    {label}
                  </span>
                  {member.user_id === currentUserId ? (
                    <span className="ml-1 text-[10px] text-gray-400">
                      (You)
                    </span>
                  ) : null}
                </TablePrimaryCell>
                <TableCell className="ml-auto w-64">
                  {member.email || "—"}
                </TableCell>
                <TableCell className="w-32 overflow-visible">
                  <OrganizationRoleTab
                    role={member.role}
                    label={label}
                    assignableRoles={assignableRoles}
                    disabled={busyMemberId === member.user_id}
                    onChange={(role) => onRoleChange(member, role)}
                  />
                </TableCell>
                <TableCell className="w-36">
                  {formatDate(member.created_at)}
                </TableCell>
                <TableCell className="flex w-10 justify-end overflow-visible">
                  {canRemove ? (
                    <HeaderActionsMenu
                      title={`Actions for ${label}`}
                      items={[
                        {
                          label:
                            member.user_id === currentUserId
                              ? "Leave organization"
                              : "Remove member",
                          icon: Trash2,
                          variant: "danger",
                          onSelect: () => onRemove(member),
                        },
                      ]}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      )}
      <TableLoadMoreRow
        loading={loading}
        hasMore={hasMoreMembers}
        itemCount={shownMembers.length}
        loadingMore={false}
        hasError={false}
        onLoadMore={showMoreMembers}
        autoLoadOnVisible
      />
    </TableScrollArea>
  );
}

function OrganizationRoleTab({
  role,
  label,
  assignableRoles,
  disabled,
  onChange,
}: {
  role: OrgRole;
  label: string;
  assignableRoles: OrgRole[];
  disabled: boolean;
  onChange: (role: OrgRole) => void;
}) {
  const editable = assignableRoles.length > 1;
  const tone =
    role === "owner"
      ? "bg-blue-100 text-blue-700"
      : role === "admin"
        ? "bg-violet-100 text-violet-700"
        : "bg-gray-100 text-gray-600";
  const className = `inline-flex h-6 min-w-20 items-center justify-center gap-1 rounded-full px-2 text-[11px] font-medium ${tone}`;

  if (!editable) {
    return <span className={className}>{ORG_ROLE_LABELS[role]}</span>;
  }

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          type="button"
          aria-label={`Change role for ${label}`}
          disabled={disabled}
          className={`${className} transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-wait disabled:opacity-50`}
        >
          <span className="flex-1 text-center">{ORG_ROLE_LABELS[role]}</span>
          {disabled ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )}
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-36">
        {ROLE_FILTER_OPTIONS.filter((option) =>
          assignableRoles.includes(option.value),
        ).map((option) => (
          <DropdownItem
            key={option.value}
            selected={role === option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between"
          >
            <span className={option.className}>{option.label}</span>
            {role === option.value ? (
              <Check className="h-3.5 w-3.5 text-gray-400" />
            ) : null}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}

/** Matches the people table's columns and compact identity layout while member data loads. */
function LoadingRows({ columns }: { columns: string[] }) {
  return (
    <TableBody>
      {[1, 2, 3].map((row) => (
        <TableRow key={row} interactive={false}>
          <TableStickyCell hover={false} bgClassName="bg-transparent">
            <SkeletonCheckbox />
            <span className="mr-2 h-4 w-4 shrink-0 animate-pulse rounded-full bg-gray-100" />
            <SkeletonLine className="w-40" />
          </TableStickyCell>
          {columns.map((width, index) => (
            <TableCell
              key={`${width}-${index}`}
              className={`${index === 0 ? "ml-auto " : ""}${width}`}
            >
              <SkeletonLine className="w-20" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => Promise<void>;
}) {
  return (
    <TableEmptyState>
      <EmptyState
        icon={<OrganizationSkeuoIcon />}
        title="Organization"
        description={error}
        tone="error"
        action={
          <button
            type="button"
            onClick={() => void onRetry()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Loader2 className="h-3.5 w-3.5" />
            Try again
          </button>
        }
      />
    </TableEmptyState>
  );
}

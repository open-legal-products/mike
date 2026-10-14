"use client";

import { UserAvatar } from "@/app/components/ui/user-avatar";

import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Info, Loader2 } from "lucide-react";
import type { UserLookupResult } from "@/app/lib/mikeApi";
import type { AccessAssignmentRole } from "@/app/lib/mikeApi";
import type { ContentVisibility } from "@/app/components/shared/types";
import {
    PROJECT_ROLE_DESCRIPTIONS,
    PROJECT_ROLE_LABELS,
    PROJECT_ROLES,
    type ProjectRole,
} from "@/app/lib/permissions";
import { AddUserInput } from "../shared/AddUserInput";
import { SearchBar } from "../ui/search-bar";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import {
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
} from "@/shared/ui/LiquidGlassUI";

export type AccessScope = "direct" | "project";

export interface AccessRow {
    key?: string;
    email: string | null;
    user_id?: string | null;
    display_name: string | null;
    profile_photo?: string | null;
    role: AccessAssignmentRole;
    isCreator?: boolean;
}

export type OrganizationAccessAssignment = AccessRow;

const INPUT_GROUP_ROLE_TRIGGER_CLASS =
    "flex h-10 shrink-0 items-center gap-1.5 px-3 text-xs shadow-none transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 data-[state=open]:opacity-80 [&[data-state=open]>svg]:rotate-180 disabled:cursor-not-allowed disabled:opacity-50";

export function accessRoleLabel(role: AccessAssignmentRole): string {
    return role === "deny" ? "Deny" : PROJECT_ROLE_LABELS[role];
}

function accessRoleTone(role: AccessAssignmentRole): string {
    return role === "owner"
        ? "bg-blue-100 text-blue-700"
        : role === "editor"
          ? "bg-violet-100 text-violet-700"
          : role === "deny"
            ? "bg-red-100 text-red-700"
            : "bg-gray-100 text-gray-600";
}

function accessRoleTextTone(role: AccessAssignmentRole): string {
    return role === "owner"
        ? "text-blue-700"
        : role === "editor"
          ? "text-violet-700"
          : role === "deny"
            ? "text-red-700"
            : "text-gray-600";
}

function accessRoleMenuTone(role: AccessAssignmentRole): string {
    return role === "owner"
        ? "text-blue-700 hover:!bg-blue-100 focus:!bg-blue-100 data-[highlighted]:!bg-blue-100 data-[selected=true]:!bg-blue-100"
        : role === "editor"
          ? "text-violet-700 hover:!bg-violet-100 focus:!bg-violet-100 data-[highlighted]:!bg-violet-100 data-[selected=true]:!bg-violet-100"
          : role === "deny"
            ? "text-red-700 hover:!bg-red-100 focus:!bg-red-100 data-[highlighted]:!bg-red-100 data-[selected=true]:!bg-red-100"
            : "text-gray-600 hover:!bg-gray-100 focus:!bg-gray-100 data-[highlighted]:!bg-gray-100 data-[selected=true]:!bg-gray-100";
}

function AccessRolePill({
    role,
    label,
    editable,
    disabled,
    loading,
    onChange,
    options,
}: {
    role: AccessAssignmentRole;
    label: string;
    editable: boolean;
    disabled: boolean;
    loading: boolean;
    onChange: (role: AccessAssignmentRole) => void;
    options: AccessAssignmentRole[];
}) {
    const tone = accessRoleTone(role);
    const className = `inline-flex h-6 items-center justify-self-start justify-center gap-1 rounded-full px-2 text-left text-[11px] font-medium ${tone}`;

    if (!editable) return <span className={className}>{accessRoleLabel(role)}</span>;

    return (
        <Dropdown>
            <DropdownTrigger asChild>
                <button
                    type="button"
                    aria-label={`Role for ${label}`}
                    disabled={disabled}
                    className={`${className} transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-wait disabled:opacity-50`}
                >
                    <span>{accessRoleLabel(role)}</span>
                    {loading ? (
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    ) : (
                        <ChevronDown className="h-3 w-3 shrink-0 text-gray-400" />
                    )}
                </button>
            </DropdownTrigger>
            <DropdownContent
                align="end"
                className="w-32"
            >
                {options.map((option) => (
                    <DropdownItem
                        key={option}
                        selected={role === option}
                        onSelect={() => onChange(option)}
                        className={`flex items-center justify-between ${accessRoleMenuTone(option)}`}
                    >
                        <span>{accessRoleLabel(option)}</span>
                        {role === option ? (
                            <Check className="h-3.5 w-3.5 text-gray-300" />
                        ) : null}
                    </DropdownItem>
                ))}
            </DropdownContent>
        </Dropdown>
    );
}

function RemoveActionDropdown({
    label,
    disabled = false,
    onRemove,
}: {
    label: string;
    disabled?: boolean;
    onRemove: () => void;
}) {
    return (
        <Dropdown>
            <DropdownTrigger asChild>
                <button
                    type="button"
                    aria-label={`Actions for ${label}`}
                    disabled={disabled}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-xs text-gray-500 hover:bg-gray-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50"
                >
                    ···
                </button>
            </DropdownTrigger>
            <DropdownContent
                align="end"
                className="min-w-28"
            >
                <DropdownItem
                    onSelect={onRemove}
                    className="text-red-500 hover:!bg-red-500/10 focus:!bg-red-500/10 data-[highlighted]:!bg-red-500/10"
                >
                    Remove
                </DropdownItem>
            </DropdownContent>
        </Dropdown>
    );
}

function InfoLabelTooltip({
    label,
    tooltipId,
    infoLabel,
    children,
}: {
    label: ReactNode;
    tooltipId: string;
    infoLabel: string;
    children: ReactNode;
}) {
    return (
        <div className="relative flex w-fit items-center gap-1.5">
            {label}
            <button
                type="button"
                aria-label={infoLabel}
                aria-describedby={tooltipId}
                className="peer flex h-5 w-5 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
                <Info className="h-3.5 w-3.5" />
            </button>
            <div
                id={tooltipId}
                role="tooltip"
                className={`pointer-events-none invisible absolute left-0 top-full z-[260] mt-1.5 w-[min(18rem,calc(100vw-3rem))] rounded-xl p-3 text-xs leading-4 text-gray-600 opacity-0 transition-opacity peer-hover:visible peer-hover:opacity-100 peer-focus-visible:visible peer-focus-visible:opacity-100 ${LIQUID_GLASS_FLOAT_CLASS}`}
            >
                {children}
            </div>
        </div>
    );
}

/** Searches eligible organization members and presents their existing roster photos for selection. */
function OrganizationMemberPicker({
    id,
    label,
    placeholder,
    description,
    showLabel = true,
    members,
    disabled,
    onSelect,
}: {
    id: string;
    label: string;
    placeholder: string;
    description?: string;
    showLabel?: boolean;
    members: AccessRow[];
    disabled: boolean;
    onSelect: (member: AccessRow) => void;
}) {
    const [query, setQuery] = useState("");
    const [focused, setFocused] = useState(false);
    const normalizedQuery = query.trim().toLowerCase();
    const matches = normalizedQuery
        ? members
              .filter((member) =>
                  [member.display_name, member.email]
                      .filter(Boolean)
                      .some((value) =>
                          value!.toLowerCase().includes(normalizedQuery),
                      ),
              )
              .slice(0, 8)
        : [];
    const showResults = focused && normalizedQuery.length > 0;

    return (
        <div className="relative">
            {showLabel ? (
                <InfoLabelTooltip
                    label={
                        <label
                            htmlFor={id}
                            className="block text-sm font-medium text-gray-700"
                        >
                            {label}
                        </label>
                    }
                    tooltipId={`${id}-description`}
                    infoLabel={`About ${label}`}
                >
                    {description}
                </InfoLabelTooltip>
            ) : null}
            <SearchBar
                id={id}
                value={query}
                onValueChange={setQuery}
                placeholder={placeholder}
                label={label}
                disabled={disabled}
                autoComplete="off"
                wrapperClassName={showLabel ? "mt-2" : undefined}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        setQuery("");
                        setFocused(false);
                    }
                }}
            />
            {showResults ? (
                <div
                    role="listbox"
                    aria-label={`${label} matches`}
                    className={`absolute left-0 right-0 top-full z-[260] mt-1 max-h-48 overflow-y-auto rounded-xl p-1 ${LIQUID_GLASS_FLOAT_CLASS}`}
                >
                    {matches.length > 0 ? (
                        matches.map((member) => {
                            const key =
                                member.key ??
                                member.user_id ??
                                member.email ??
                                "unknown";
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    role="option"
                                    aria-selected="false"
                                    onMouseDown={(event) =>
                                        event.preventDefault()
                                    }
                                    onClick={() => {
                                        onSelect(member);
                                        setQuery("");
                                        setFocused(false);
                                    }}
                                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 ${LIQUID_GLASS_HOVER_CLASS}`}
                                >
                                    <UserAvatar photo={member.profile_photo} name={member.display_name} email={member.email} />
                                    <span className="min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">
                                        <span className="block text-gray-800">{member.display_name?.trim() || member.email}</span>
                                        {member.display_name ? <span className="block text-gray-500">{member.email}</span> : null}
                                    </span>
                                </button>
                            );
                        })
                    ) : (
                        <p className="px-3 py-2 text-xs text-gray-400">
                            No matching organization members.
                        </p>
                    )}
                </div>
            ) : null}
        </div>
    );
}

/** Displays assigned people with compact avatars and responsive role controls, respecting read-only access. */
function OrganizationAssignmentList({
    label,
    assignments,
    emptyMessage,
    loading,
    disabled,
    onRemove,
    onRoleChange,
    ownerRoleImplied = false,
}: {
    label: string;
    assignments: OrganizationAccessAssignment[];
    emptyMessage: string;
    loading: boolean;
    disabled: boolean;
    onRemove: (
        assignment: OrganizationAccessAssignment,
    ) => Promise<unknown> | unknown;
    /**
     * Given for a list whose rows hold a role worth showing and changing.
     * The deny list leaves it out: every row there is the same thing.
     */
    onRoleChange?: (
        assignment: OrganizationAccessAssignment,
        role: AccessAssignmentRole,
    ) => Promise<unknown> | unknown;
    /**
     * For a list that is headed as a list of owners: an Owner row then says
     * nothing its heading has not, so it carries no role and reads as a
     * name, an email and its actions. Anyone on the list at another role
     * still shows it, or they would pass for an owner.
     */
    ownerRoleImplied?: boolean;
}) {
    const WITH_ROLE = "grid-cols-[minmax(0,1fr)_5rem_1.5rem] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5rem_1.5rem]";
    const WITHOUT_ROLE = "grid-cols-[minmax(0,1fr)_1.5rem] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.5rem]";
    return (
        <div className="min-h-28 max-h-72 overflow-y-auto rounded-xl bg-white/20 p-1">
            {loading ? (
                <div className="flex min-h-26 items-center justify-center gap-2 text-xs text-gray-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading organization members…
                </div>
            ) : assignments.length === 0 ? (
                <div className="flex min-h-26 items-center justify-center text-xs text-gray-400">
                    {emptyMessage}
                </div>
            ) : (
                <ul
                    aria-label={label}
                    className="space-y-1"
                >
                    {assignments.map((assignment) => {
                        const key =
                            assignment.key ??
                            assignment.user_id ??
                            assignment.email;
                        const showRole =
                            !!onRoleChange &&
                            !(ownerRoleImplied && assignment.role === "owner");
                        return (
                            <li
                                key={key}
                                className={`${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS} grid ${showRole ? WITH_ROLE : WITHOUT_ROLE} items-center gap-x-3 gap-y-0 sm:gap-y-3 rounded-lg px-2 py-2 transition-colors`}
                            >
                                <span className="flex min-w-0 items-center gap-2 text-xs text-gray-800">
                                    <UserAvatar photo={assignment.profile_photo} name={assignment.display_name} email={assignment.email} />
                                    <span className="min-w-0 [overflow-wrap:anywhere]">{assignment.display_name?.trim() || "—"}</span>
                                </span>
                                <span className="col-span-full row-start-2 min-w-0 max-w-full justify-self-start pl-7 text-xs text-gray-500 [overflow-wrap:anywhere] sm:col-auto sm:row-auto sm:justify-self-end sm:pl-0">
                                    {assignment.email || "—"}
                                </span>
                                {showRole && onRoleChange ? (
                                    <AccessRolePill
                                        role={assignment.role}
                                        label={
                                            assignment.email ??
                                            assignment.display_name ??
                                            "member"
                                        }
                                        // The creator is always an Owner.
                                        editable={
                                            !disabled && !assignment.isCreator
                                        }
                                        disabled={false}
                                        loading={false}
                                        onChange={(role) =>
                                            void onRoleChange(assignment, role)
                                        }
                                        options={PROJECT_ROLES}
                                    />
                                ) : null}
                                {!disabled && !assignment.isCreator ? (
                                    <RemoveActionDropdown
                                        label={
                                            assignment.email ??
                                            assignment.display_name ??
                                            "member"
                                        }
                                        onRemove={() =>
                                            void onRemove(assignment)
                                        }
                                    />
                                ) : (
                                    <span className="h-6 w-6" />
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

/**
 * Who can open an organization's project or workflow.
 *
 * Whether an item is public or private is set with its other details, not
 * here. This editor is what follows from that choice:
 *
 *   - PRIVATE: the individuals it has been shared with, each at a role
 *   - PUBLIC: every member of the organization can already open and edit
 *     it, so what is left to decide is who else OWNS it, and who is walled
 *     off from it
 *
 * Only members of the organization can be named: sharing does not reach
 * outside it. On a PUBLIC item the organization's owners are not offered:
 * they own every public item already and cannot be denied one. A PRIVATE
 * item is not theirs unless it is shared with them, so there they are
 * offered like any other member.
 */
export function OrganizationAccessEditor({
    members,
    assignments,
    organizationName,
    ownerLabel = "Project owners",
    resourceNoun: resourceNounProp,
    loading = false,
    disabled = false,
    error,
    currentUserId,
    currentUserEmail,
    visibility = "private",
    onAssign,
    onRemove,
}: {
    /**
     * Every member of the organization, as candidates. A row whose `role` is
     * "owner" is one of the organization's owners, who are left out of the
     * pickers on a public item; the creator is left out always.
     */
    members: AccessRow[];
    /** The creator, and everyone the item is shared with or denied from. */
    assignments: OrganizationAccessAssignment[];
    organizationName?: string | null;
    ownerLabel?: string;
    /**
     * What the item is called in the descriptions. Read off `ownerLabel`
     * when not given, which only tells a workflow from a project.
     */
    resourceNoun?: string;
    loading?: boolean;
    disabled?: boolean;
    error?: string | null;
    /**
     * Who is looking. Both identifiers, because a roster row can arrive with
     * one and not the other — and the server refuses a grant aimed at the
     * caller ("You cannot share a project with yourself"), so offering their
     * own name in these pickers only ever produced that error.
     */
    currentUserId?: string | null;
    currentUserEmail?: string | null;
    /** Set on the item's details, and only read here. */
    visibility?: ContentVisibility;
    onAssign: (
        member: AccessRow,
        role: AccessAssignmentRole,
    ) => Promise<unknown> | unknown;
    onRemove: (
        assignment: OrganizationAccessAssignment,
    ) => Promise<unknown> | unknown;
}) {
    const isPublic = visibility === "organization";
    const assignedKeys = new Set(
        assignments.map(
            (assignment) =>
                assignment.user_id ??
                assignment.email?.toLowerCase() ??
                assignment.key ??
                "",
        ),
    );
    const selfEmail = currentUserEmail?.trim().toLowerCase() ?? null;
    const isSelf = (member: AccessRow) =>
        (!!currentUserId && member.user_id === currentUserId) ||
        (!!selfEmail && member.email?.trim().toLowerCase() === selfEmail);
    const availableMembers = members.filter((member) => {
        if (member.isCreator || !member.email) return false;
        // The organization's owners own every public item; the server
        // refuses to give them a role on one or deny them it. A private
        // item is shared with them like with anybody else.
        if (isPublic && member.role === "owner") return false;
        // Nothing can be aimed at the caller: the server answers "You cannot
        // share a project with yourself", so their own row in these pickers
        // was an action that could only fail.
        if (isSelf(member)) return false;
        return !assignedKeys.has(
            member.user_id ?? member.email.toLowerCase(),
        );
    });
    const sharedAssignments = assignments.filter(
        (assignment) => assignment.role !== "deny",
    );
    const deniedAssignments = assignments.filter(
        (assignment) => assignment.role === "deny",
    );
    const denyCount = deniedAssignments.length;
    // An existing deny list is a security decision somebody needs to see, so
    // the section opens itself when there is anything in it. The assignments
    // arrive with the roster, after mount, so the mount-time initialiser is
    // not enough on its own — re-derive it when the load finishes.
    //
    // Once only, though. Every grant and revoke re-reads the roster, and each
    // of those re-runs this: a deny list the user had deliberately collapsed
    // sprang open again after their next change, and again after the one
    // after that. Opening it the first time is the point being made; after
    // that the section is theirs.
    const [denyState, setDenyState] = useState({
        loading,
        expanded: denyCount > 0,
        autoExpanded: denyCount > 0,
    });
    if (denyState.loading !== loading) {
        const settled = !loading;
        const shouldAutoExpand =
            settled && !denyState.autoExpanded && denyCount > 0;
        setDenyState({
            loading,
            expanded: shouldAutoExpand ? true : denyState.expanded,
            autoExpanded: denyState.autoExpanded || (settled && denyCount > 0),
        });
    }
    const denyExpanded = denyState.expanded;
    const toggleDenyExpanded = () =>
        setDenyState((current) => ({
            ...current,
            expanded: !current.expanded,
        }));
    const resourceNoun =
        resourceNounProp ??
        (ownerLabel.toLowerCase().startsWith("workflow")
            ? "workflow"
            : "project");
    const organizationLabel = organizationName || "the organisation";
    const peopleDescription = `Share this ${resourceNoun} with members of ${organizationLabel}. They are added as Editors; change a person's role in the list below. It cannot be shared outside the organisation.`;
    // Everyone can already open and edit a public item, so the only standing
    // left to hand out is ownership of it.
    const ownerDescription = `Add ${organizationLabel} members as owners with rights to manage access, settings and delete the ${resourceNoun}. Everyone in ${organizationLabel} can already open and edit it.`;
    const denyDescription = `Deny ${organizationLabel} members from accessing this ${resourceNoun}, although it is open to everyone else.`;
    // A wall only means something on a public item; on a private one, not
    // being added is the wall. An existing list is still shown, so that
    // making the item public again is not a surprise.
    const showDenySection = isPublic || denyCount > 0;

    return (
        <div
            data-slot="organization-access-editor"
            className="flex min-h-0 flex-1 flex-col gap-4 pb-1"
        >
            <section className="space-y-2">
                {isPublic ? (
                    <OrganizationMemberPicker
                        id="organization-owner-picker"
                        label={ownerLabel}
                        placeholder="Search members…"
                        description={ownerDescription}
                        members={availableMembers}
                        disabled={disabled || loading}
                        onSelect={(member) => onAssign(member, "owner")}
                    />
                ) : (
                    // Everybody is added as an Editor. Whoever needs more or
                    // less is changed in their row below, where the role can
                    // be seen beside the person it belongs to.
                    <OrganizationMemberPicker
                        id="organization-people-picker"
                        label="People"
                        placeholder="Search members…"
                        description={peopleDescription}
                        members={availableMembers}
                        disabled={disabled || loading}
                        onSelect={(member) => onAssign(member, "editor")}
                    />
                )}
                <OrganizationAssignmentList
                    label={
                        isPublic ? `${ownerLabel} list` : "People with access"
                    }
                    assignments={sharedAssignments}
                    emptyMessage={
                        isPublic
                            ? "No additional Owners added."
                            : "Not shared with anyone yet."
                    }
                    loading={loading}
                    disabled={disabled}
                    onRemove={onRemove}
                    onRoleChange={(assignment, role) =>
                        onAssign(assignment, role)
                    }
                    // A public item's list is its owners.
                    ownerRoleImplied={isPublic}
                />
            </section>

            {error ? (
                <p role="alert" className="text-xs text-red-500">
                    {error}
                </p>
            ) : null}

            {showDenySection ? (
                <section className="mt-auto pt-2">
                    <InfoLabelTooltip
                        label={
                            <button
                                type="button"
                                aria-expanded={denyExpanded}
                                aria-controls="organization-deny-list-content"
                                onClick={toggleDenyExpanded}
                                className="flex items-center gap-1.5 rounded-lg text-left text-sm font-medium text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                            >
                                <span>
                                    {denyCount > 0
                                        ? `Deny list (${denyCount})`
                                        : "Deny list"}
                                </span>
                                <ChevronDown
                                    aria-hidden="true"
                                    className={`h-3.5 w-3.5 text-gray-400 transition-transform ${denyExpanded ? "rotate-180" : ""}`}
                                />
                            </button>
                        }
                        tooltipId="organization-deny-description"
                        infoLabel="About the Deny list"
                    >
                        {denyDescription}
                    </InfoLabelTooltip>
                    {denyExpanded ? (
                        <div
                            id="organization-deny-list-content"
                            className="mt-2 space-y-2"
                        >
                            <OrganizationMemberPicker
                                id="organization-deny-picker"
                                label="Deny list"
                                showLabel={false}
                                placeholder="Search members…"
                                members={availableMembers}
                                disabled={disabled || loading}
                                onSelect={(member) => onAssign(member, "deny")}
                            />
                            <OrganizationAssignmentList
                                label="Deny list entries"
                                assignments={deniedAssignments}
                                emptyMessage="No members denied."
                                loading={loading}
                                disabled={disabled}
                                onRemove={onRemove}
                            />
                        </div>
                    ) : null}
                </section>
            ) : null}
        </div>
    );
}

/**
 * Renders shared access controls for direct grants, organization assignments, and inherited project access.
 * Receives authorized roster identities and delegates changes to the owning flow.
 */
export function AccessEditor({
    scope,
    rows,
    loading = false,
    canManage,
    currentUserEmail,
    currentUserId,
    busy = false,
    pendingEmail = null,
    newRole,
    onNewRoleChange,
    onAdd,
    validateEmail,
    onRoleChange,
    onRemove,
    error,
}: {
    scope: AccessScope;
    rows: AccessRow[];
    loading?: boolean;
    canManage: boolean;
    currentUserEmail?: string | null;
    currentUserId?: string | null;
    busy?: boolean;
    pendingEmail?: string | null;
    newRole: ProjectRole;
    onNewRoleChange: (role: ProjectRole) => void;
    onAdd?: (
        user: UserLookupResult,
    ) => Promise<boolean | void> | boolean | void;
    validateEmail?: (email: string) => string | null;
    onRoleChange?: (
        row: AccessRow,
        role: AccessAssignmentRole,
    ) => Promise<unknown> | unknown;
    onRemove?: (row: AccessRow) => Promise<unknown> | unknown;
    error?: string | null;
}) {
    const roleOptions = PROJECT_ROLES;
    const normalizedCurrentEmail = currentUserEmail?.trim().toLowerCase();
    const normalizedCurrentUserId = currentUserId?.trim() || null;

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
            {scope === "direct" && canManage && onAdd ? (
                <section className="space-y-2">
                    <InfoLabelTooltip
                        label={
                            <h2 className="text-sm font-medium text-gray-700">
                                Share Access
                            </h2>
                        }
                        tooltipId="access-role-rights"
                        infoLabel="About access roles"
                    >
                        <div>
                            <p className="mb-2 text-xs font-medium text-gray-700">
                                Roles and rights
                            </p>
                            <dl className="space-y-2">
                                {PROJECT_ROLES.map((role) => (
                                    <div
                                        key={role}
                                        className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 text-xs"
                                    >
                                        <dt
                                            className={`font-medium ${accessRoleTextTone(role)}`}
                                        >
                                            {accessRoleLabel(role)}
                                        </dt>
                                        <dd className="leading-4 text-gray-500">
                                            {PROJECT_ROLE_DESCRIPTIONS[role]}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        </div>
                    </InfoLabelTooltip>
                    <AddUserInput
                        onAdd={onAdd}
                        validateEmail={validateEmail}
                        busy={busy}
                        placeholder="Add by email..."
                        autoFocus
                        submitLabel="Add"
                        submitVariant="attached"
                        inputEndControl={
                            <Dropdown>
                                <DropdownTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label={`Role for the new recipient: ${accessRoleLabel(newRole)}`}
                                        disabled={busy}
                                        className={`${INPUT_GROUP_ROLE_TRIGGER_CLASS} bg-transparent ${accessRoleTextTone(newRole)}`}
                                    >
                                        <span>{accessRoleLabel(newRole)}</span>
                                        <ChevronDown className="h-3 w-3 shrink-0 text-gray-300" />
                                    </button>
                                </DropdownTrigger>
                                <DropdownContent
                                    align="end"
                                    className="w-32"
                                >
                                    {PROJECT_ROLES.map((role) => (
                                        <DropdownItem
                                            key={role}
                                            selected={newRole === role}
                                            onSelect={() => onNewRoleChange(role)}
                                            className={`flex items-center justify-between ${accessRoleMenuTone(role)}`}
                                        >
                                            <span>{accessRoleLabel(role)}</span>
                                            {newRole === role ? (
                                                <Check className="h-3.5 w-3.5 text-gray-300" />
                                            ) : null}
                                        </DropdownItem>
                                    ))}
                                </DropdownContent>
                            </Dropdown>
                        }
                        className="bg-white focus-within:bg-white"
                    />
                </section>
            ) : null}

            {/* One alert for every scope: the add form is only rendered to a
                manager in the direct scope, so an error nested inside it was
                invisible when a re-role or a revoke failed anywhere else. */}
            {error ? (
                <p role="alert" className="text-xs text-red-500">
                    {error}
                </p>
            ) : null}

            <section className="flex min-h-0 flex-1 flex-col">
                {scope === "project" ? (
                    <p className="mb-3 text-xs text-gray-500">
                        Access is inherited from the project and must be changed
                        from the project&apos;s Access panel.
                    </p>
                ) : null}

                <div className="mb-1 hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5rem_1.5rem] gap-3 px-2 text-xs font-medium text-gray-500">
                    <div className="flex items-center gap-2">
                        <span>Name</span>
                        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    </div>
                    <span className="justify-self-start text-left">Email</span>
                    <span className="justify-self-start text-left">Role</span>
                    <span aria-hidden="true" />
                </div>

                {loading ? (
                    <div className="min-h-0 flex-1 space-y-1">
                        {[1, 2].map((item) => (
                            <div
                                key={item}
                                className="grid grid-cols-[minmax(0,1fr)_5rem_1.5rem] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5rem_1.5rem] items-center gap-x-3 gap-y-0 sm:gap-y-3 rounded-lg px-2 py-2"
                            >
                                <div className="flex min-w-0 items-center gap-2">
                                    <div className="h-5 w-5 shrink-0 animate-pulse rounded-full bg-gray-100" />
                                    <div className="h-3 w-20 animate-pulse rounded bg-gray-100" />
                                </div>
                                <div className="col-span-full row-start-2 ml-7 h-3 w-28 animate-pulse rounded bg-gray-100 sm:col-auto sm:row-auto sm:ml-0" />
                                <div className="h-4 w-12 animate-pulse rounded-full bg-gray-100" />
                                <div className="h-6 w-6" />
                            </div>
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    // In the inherited scope the note above already explains
                    // where access comes from; "No one has access yet"
                    // underneath it reads as a contradiction.
                    scope === "project" ? null : (
                        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-400">
                            No one has access yet.
                        </div>
                    )
                ) : (
                    <div
                        role="list"
                        className="min-h-0 flex-1 space-y-1 overflow-y-auto"
                    >
                        {rows.map((entry) => {
                            const rowKey =
                                entry.key ?? entry.user_id ?? entry.email ?? "unknown";
                            const email = entry.email ?? "";
                            // Either identifier is enough; when neither is
                            // known the row stays interactive rather than
                            // guessing which grant belongs to the viewer.
                            const isYou =
                                (!!normalizedCurrentUserId &&
                                    entry.user_id === normalizedCurrentUserId) ||
                                (!!normalizedCurrentEmail &&
                                    email.toLowerCase() ===
                                        normalizedCurrentEmail);
                            const name = isYou
                                ? "You"
                                : entry.display_name?.trim() || "—";
                            const isPending = pendingEmail === email;
                            return (
                                <div
                                    key={rowKey}
                                    role="listitem"
                                    className={`${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS} relative grid grid-cols-[minmax(0,1fr)_5rem_1.5rem] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5rem_1.5rem] items-start gap-x-3 gap-y-0 sm:gap-y-3 rounded-lg px-2 py-2 transition-colors`}
                                >
                                    <div className="flex min-w-0 items-center gap-2 text-xs text-gray-800">
                                        <UserAvatar photo={entry.profile_photo} name={entry.display_name} email={entry.email} />
                                        <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
                                    </div>
                                    <p className="col-span-full row-start-2 min-w-0 justify-self-start pl-7 text-left text-xs text-gray-500 [overflow-wrap:anywhere] sm:col-auto sm:row-auto sm:pl-0 sm:pt-1">{entry.email || "—"}</p>
                                    <AccessRolePill
                                        role={entry.role}
                                        label={email || name}
                                        editable={
                                            !entry.isCreator &&
                                            // Re-roling yourself is refused by
                                            // the server ("You cannot share a
                                            // project with yourself"), so the
                                            // picker only ever produced an
                                            // error.
                                            !isYou &&
                                            canManage &&
                                            scope !== "project" &&
                                            !!onRoleChange
                                        }
                                        disabled={busy}
                                        loading={busy && isPending}
                                        onChange={(role) => onRoleChange?.(entry, role)}
                                        options={roleOptions}
                                    />
                                    <div className="relative h-6 w-6">
                                        {/* No Remove on your own grant: one
                                            unconfirmed click would lock the
                                            viewer out of the resource. */}
                                        {!entry.isCreator &&
                                        !isYou &&
                                        canManage &&
                                        scope === "direct" &&
                                        onRemove ? (
                                            <RemoveActionDropdown
                                                label={email}
                                                disabled={busy}
                                                onRemove={() =>
                                                    void onRemove(entry)
                                                }
                                            />
                                        ) : null}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );
}

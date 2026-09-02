"use client";

import { useEffect, useMemo, useState } from "react";
import { User, Loader2 } from "lucide-react";
import type { ProjectPeople } from "@/app/lib/mikeApi";
import {
    isProjectRole,
    PROJECT_ROLE_DESCRIPTIONS,
    PROJECT_ROLE_LABELS,
    PROJECT_ROLES,
    type ProjectRole,
    strongerRole,
} from "@/app/lib/permissions";
import { AddUserInput } from "../shared/AddUserInput";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { Modal } from "./Modal";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

/**
 * Any resource the modal can manage members for — projects (through access
 * grants) and tabular reviews (still a roleless email list).
 */
export interface SharedResource {
    id: string;
    shared_with?: string[] | null;
    owner_display_name?: string | null;
    owner_email?: string | null;
}

/**
 * The role-aware sharing path. A project's recipients each hold their own
 * role, so the caller supplies the grant list plus the two mutations that
 * maintain it, instead of a whole-list setter that could only ever express
 * "has access / doesn't".
 */
export interface AccessControls {
    grants: { email: string; role: ProjectRole }[];
    /** The owning organization, if any — changes what the dialog explains. */
    orgId?: string | null;
    /**
     * Whether the caller may change access. Everyone who can see the project
     * sees the roster and each person's role; only project admins get the
     * controls.
     */
    canManage: boolean;
    /** Create or re-role one recipient. */
    onGrant: (email: string, role: ProjectRole) => Promise<void>;
    onRevoke: (email: string) => Promise<void>;
}

interface Props {
    open: boolean;
    onClose: () => void;
    /** The thing being shared (project, review, …). */
    resource: SharedResource | null;
    /**
     * Resolve the owner + members roster for the given resource. Different
     * resource types hit different endpoints (`/projects/:id/people`,
     * `/tabular-review/:id/people`, …) so the caller passes the appropriate
     * fetcher.
     */
    fetchPeople: (id: string) => Promise<ProjectPeople>;
    /** Currently signed-in user's email — gets the "You" tag if it matches. */
    currentUserEmail?: string | null;
    breadcrumb: string[];
    /**
     * Roleless path (tabular reviews): persist a new shared_with list. Parent
     * should PATCH the resource and sync its local state on success. Throw to
     * surface an error inline.
     */
    onSharedWithChange?: (sharedWith: string[]) => Promise<void> | void;
    /** Role-aware path (projects). Takes precedence over onSharedWithChange. */
    access?: AccessControls | null;
}

type RosterRow = {
    email: string | null;
    user_id?: string | null;
    display_name: string | null;
    role: ProjectRole;
    /** Set when the server enforces a stronger role than the direct grant —
     *  inheritance from an org role the grant cannot demote. */
    effectiveRole?: ProjectRole;
    /** The creator's row is provenance — it has no grant to edit or revoke. */
    isCreator: boolean;
};

const ROLE_SELECT_CLASS = `h-6 rounded-full px-2 text-xs text-gray-700 ${LIQUID_GLASS_SUBTLE_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50`;

/**
 * Roster of everyone with access to the project or review, with controls to
 * add, re-role and remove recipients.
 *
 * On projects each recipient carries an explicit role, and the roster reads
 * the grant list rather than deriving every direct share as a full
 * collaborator from a roleless `shared_with` array. Grants are addressed by
 * email and are independent of organization membership, which is what lets a
 * firm hand one matter to outside counsel as a viewer without letting them
 * into the organization.
 */
export function PeopleModal({
    open,
    onClose,
    resource,
    fetchPeople,
    currentUserEmail,
    breadcrumb,
    onSharedWithChange,
    access,
}: Props) {
    const [busy, setBusy] = useState<"add" | "remove" | "role" | null>(null);
    const [pendingEmail, setPendingEmail] = useState<string | null>(null);
    const [memberMenuEmail, setMemberMenuEmail] = useState<string | null>(null);
    const [newRole, setNewRole] = useState<ProjectRole>("member");
    const [error, setError] = useState<string | null>(null);

    // Server-resolved roster: owner email/display_name + members'
    // display_names. Membership itself comes from the grant list (projects)
    // or `resource.shared_with` (reviews); this fetch supplies display names.
    const [people, setPeople] = useState<ProjectPeople | null>(null);
    const [lookupDisplayByEmail, setLookupDisplayByEmail] = useState<
        Map<string, string | null>
    >(new Map());
    const [peopleLoading, setPeopleLoading] = useState(false);
    const [loadedRosterKey, setLoadedRosterKey] = useState<string | null>(null);

    const roleAware = !!access;
    const canManage = roleAware
        ? !!access?.canManage
        : !!onSharedWithChange;

    const resourceId = resource?.id ?? null;
    const sharedWith: string[] = useMemo(
        () =>
            Array.isArray(resource?.shared_with)
                ? (resource.shared_with as string[])
                : [],
        [resource?.shared_with],
    );
    const grants = useMemo(() => access?.grants ?? [], [access?.grants]);

    useEffect(() => {
        if (!open) return;
        setError(null);
        setBusy(null);
        setPendingEmail(null);
        setMemberMenuEmail(null);
        setNewRole("member");
    }, [open]);

    useEffect(() => {
        if (!memberMenuEmail) return;
        function handleClickAway(event: PointerEvent) {
            const target = event.target;
            if (
                target instanceof HTMLElement &&
                target.closest("[data-people-member-menu]")
            ) {
                return;
            }
            setMemberMenuEmail(null);
        }
        document.addEventListener("pointerdown", handleClickAway);
        return () =>
            document.removeEventListener("pointerdown", handleClickAway);
    }, [memberMenuEmail]);

    // Re-fetch the roster whenever the modal opens or membership changes —
    // keyed by the membership list so add/remove triggers a refresh.
    const membershipKey = (
        roleAware ? grants.map((g) => `${g.email}:${g.role}`) : sharedWith
    )
        .map((entry) => entry.toLowerCase())
        .sort()
        .join(",");
    const rosterKey = `${resourceId ?? ""}:${membershipKey}`;

    useEffect(() => {
        if (!open || !resourceId) return;
        let cancelled = false;
        setPeopleLoading(true);
        setPeople(null);
        setLoadedRosterKey(null);
        fetchPeople(resourceId)
            .then((data) => {
                if (cancelled) return;
                setPeople(data);
                setLoadedRosterKey(rosterKey);
            })
            .catch(() => {
                if (!cancelled) setLoadedRosterKey(rosterKey);
            })
            .finally(() => {
                if (!cancelled) setPeopleLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, resourceId, rosterKey, fetchPeople]);

    if (!open || !resource) return null;

    const memberDisplayByEmail = new Map<string, string | null>();
    const effectiveRoleByEmail = new Map<string, ProjectRole>();
    for (const m of people?.members ?? []) {
        memberDisplayByEmail.set(m.email.toLowerCase(), m.display_name);
        if (m.role) effectiveRoleByEmail.set(m.email.toLowerCase(), m.role);
    }
    const creatorEmail =
        people?.owner?.email?.trim().toLowerCase() ??
        resource.owner_email?.trim().toLowerCase() ??
        null;
    const creatorDisplayName =
        people?.owner?.display_name ?? resource.owner_display_name ?? null;

    const roster: RosterRow[] = [];
    // The creator can be absent: an organization's project outlives the
    // account that opened it, and its admins administer it from then on.
    if (people?.owner || creatorEmail || creatorDisplayName) {
        roster.push({
            email: creatorEmail,
            user_id: people?.owner?.user_id ?? null,
            display_name: creatorDisplayName,
            role: "admin",
            isCreator: true,
        });
    }
    const recipients: { email: string; role: ProjectRole }[] = roleAware
        ? canManage
            ? grants
            : // Below access.manage the grant list is never fetched — the
              // endpoint is admin-only — but the roster itself is not
              // privileged: /people serves every collaborator with their
              // effective role, which is exactly what a member should see
              // here. Everyone who can see the project sees who else is on
              // it; only the controls are the admin's.
              (people?.members ?? []).map((member) => ({
                  email: member.email,
                  role: member.role ?? ("member" as ProjectRole),
              }))
        : sharedWith.map((email) => ({ email, role: "member" as ProjectRole }));
    for (const recipient of recipients) {
        const lower = recipient.email.toLowerCase();
        if (creatorEmail && lower === creatorEmail) continue;
        const effectiveRole = effectiveRoleByEmail.get(lower);
        roster.push({
            email: recipient.email,
            display_name:
                memberDisplayByEmail.get(lower) ??
                lookupDisplayByEmail.get(lower) ??
                null,
            role: recipient.role,
            // The picker edits the GRANT; the server's verdict is the
            // strongest of every branch. When they differ (an org admin
            // holding a viewer grant), showing only the grant would present
            // a role the server does not enforce.
            effectiveRole:
                effectiveRole &&
                strongerRole(effectiveRole, recipient.role) !== recipient.role
                    ? effectiveRole
                    : undefined,
            isCreator: false,
        });
    }

    const normalizedCurrentUserEmail =
        currentUserEmail?.trim().toLowerCase() ?? null;
    const recipientEmails = recipients.map((r) => r.email.toLowerCase());
    const rosterPending = peopleLoading || loadedRosterKey !== rosterKey;

    function validateNewEmail(email: string) {
        if (recipientEmails.includes(email)) return `${email} already has access.`;
        if (creatorEmail && email === creatorEmail) {
            return `${email} created this and is already an admin.`;
        }
        if (
            normalizedCurrentUserEmail &&
            email === normalizedCurrentUserEmail
        ) {
            return "You cannot share this with yourself.";
        }
        return null;
    }

    async function handleAddUser(user: {
        email: string;
        display_name: string | null;
    }) {
        setLookupDisplayByEmail((prev) => {
            const next = new Map(prev);
            next.set(user.email.trim().toLowerCase(), user.display_name);
            return next;
        });
        await handleAdd(user.email);
    }

    async function handleAdd(email: string) {
        if (busy !== null) return;
        setBusy("add");
        setError(null);
        // Failures propagate deliberately. `AddUserInput` renders them
        // through `userFacingApiError`, which shows an intentional 4xx detail
        // and falls back to a generic line for anything else — but only while
        // the error still carries its status. Catching here and rethrowing
        // `new Error("Couldn't add the member. Try again.")` stripped that, so
        // the grants endpoint's own sentences ("The project creator already
        // has admin access", "role must be admin, member or viewer") never
        // reached the person who needed to read them, and the dialog advised
        // retrying something that would fail identically.
        try {
            if (access) await access.onGrant(email, newRole);
            else if (onSharedWithChange)
                await onSharedWithChange([...sharedWith, email]);
        } finally {
            setBusy(null);
        }
    }

    async function handleRoleChange(email: string, role: ProjectRole) {
        if (!access || busy !== null) return;
        setBusy("role");
        setPendingEmail(email);
        setError(null);
        try {
            await access.onGrant(email, role);
        } catch (error) {
            setError(
                userFacingApiError(
                    error,
                    "Couldn't change that role. Try again.",
                ),
            );
        } finally {
            setBusy(null);
            setPendingEmail(null);
        }
    }

    async function handleRemove(email: string) {
        if (busy !== null) return;
        setBusy("remove");
        setPendingEmail(email);
        setError(null);
        try {
            if (access) await access.onRevoke(email);
            else if (onSharedWithChange)
                await onSharedWithChange(
                    sharedWith.filter(
                        (e) => e.toLowerCase() !== email.toLowerCase(),
                    ),
                );
        } catch (error) {
            setError(
                userFacingApiError(
                    error,
                    "Couldn't remove the member. Try again.",
                ),
            );
        } finally {
            setBusy(null);
            setPendingEmail(null);
            setMemberMenuEmail(null);
        }
    }

    return (
        <Modal open={open} onClose={onClose} breadcrumbs={breadcrumb}>
            <div className="flex min-h-0 flex-1 flex-col gap-5 pb-5">
                {/* Add-member row */}
                {canManage && (
                    <section className="space-y-2">
                        <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                                <AddUserInput
                                    onAdd={handleAddUser}
                                    validateEmail={validateNewEmail}
                                    busy={busy === "add"}
                                    placeholder="Add by email..."
                                    autoFocus
                                    submitLabel="Add member"
                                    className="bg-white focus-within:bg-white"
                                    // A grant is claimed by email whenever its
                                    // recipient signs up, so outside counsel
                                    // can be invited before they have an
                                    // account.
                                    requireExistingUser={!roleAware}
                                />
                            </div>
                            {roleAware && (
                                <select
                                    aria-label="Role for the new recipient"
                                    value={newRole}
                                    onChange={(event) => {
                                        if (isProjectRole(event.target.value))
                                            setNewRole(event.target.value);
                                    }}
                                    disabled={busy !== null}
                                    title={PROJECT_ROLE_DESCRIPTIONS[newRole]}
                                    className={cn(ROLE_SELECT_CLASS, "mt-2 h-8")}
                                >
                                    {PROJECT_ROLES.map((role) => (
                                        <option key={role} value={role}>
                                            {PROJECT_ROLE_LABELS[role]}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>
                        <p className="text-xs text-gray-500">
                            {PROJECT_ROLE_LABELS[newRole]}:{" "}
                            {PROJECT_ROLE_DESCRIPTIONS[newRole]}
                        </p>
                        {error && (
                            <p className="mt-1.5 text-xs text-red-500">
                                {error}
                            </p>
                        )}
                    </section>
                )}

                <section className="flex min-h-0 flex-1 flex-col">
                    <div className="mb-2 flex items-center gap-2">
                        <h3 className="text-xs font-medium text-gray-500">
                            People with Access
                        </h3>
                        {peopleLoading && (
                            <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
                        )}
                    </div>

                    {access?.orgId && (
                        <p className="mb-2 text-xs text-gray-500">
                            This project belongs to an organization. Its admins
                            can already administer it and its members can
                            already collaborate on it; the people listed here
                            were invited individually.
                        </p>
                    )}

                    {/* Member list */}
                    {rosterPending ? (
                        <div className="min-h-0 flex-1 space-y-1">
                            {[1, 2].map((item) => (
                                <div
                                    key={item}
                                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
                                >
                                    <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-gray-100" />
                                    <div className="min-w-0 flex-1">
                                        <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
                                    </div>
                                    <div className="h-4 w-12 shrink-0 animate-pulse rounded-full bg-gray-100" />
                                </div>
                            ))}
                        </div>
                    ) : roster.length === 0 ? (
                        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-400">
                            No one has access yet.
                        </div>
                    ) : (
                        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                            {roster.map((entry) => {
                                const entryEmail = entry.email ?? "";
                                const rowKey =
                                    entry.email ??
                                    entry.user_id ??
                                    `${entry.role}-unknown`;
                                const isYou =
                                    !!currentUserEmail &&
                                    !!entryEmail &&
                                    entryEmail.toLowerCase() ===
                                        currentUserEmail.toLowerCase();
                                const isPending = pendingEmail === entryEmail;
                                const displayName = entry.display_name?.trim();
                                const primary = isYou
                                    ? "You"
                                    : displayName || entryEmail || "User";
                                const showEmail =
                                    !isYou && !!displayName && !!entryEmail;
                                const initial = displayName
                                    ?.charAt(0)
                                    .toUpperCase();
                                return (
                                    <li
                                        key={`${entry.isCreator ? "creator" : "grant"}-${rowKey}`}
                                        className={`${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS} group relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors`}
                                    >
                                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/80 bg-white text-gray-700 shadow-[0_4px_12px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.92),inset_0_-1px_0_rgba(255,255,255,0.64)]">
                                            {initial ? (
                                                <span className="font-serif text-[11px] leading-none">
                                                    {initial}
                                                </span>
                                            ) : (
                                                <User className="h-2.5 w-2.5" />
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-xs text-gray-800">
                                                {primary}
                                                {showEmail && (
                                                    <span className="text-gray-400">
                                                        {" "}
                                                        · {entry.email}
                                                    </span>
                                                )}
                                            </p>
                                        </div>
                                        {entry.isCreator ? (
                                            <span
                                                title={
                                                    PROJECT_ROLE_DESCRIPTIONS
                                                        .admin
                                                }
                                                className="shrink-0 rounded-full px-2 py-1 text-xs text-gray-400"
                                            >
                                                Admin
                                            </span>
                                        ) : (
                                            <div
                                                className="relative flex shrink-0 items-center gap-1"
                                                data-people-member-menu
                                            >
                                                {access && canManage ? (
                                                    <select
                                                        aria-label={`Role for ${entryEmail}`}
                                                        value={entry.role}
                                                        disabled={busy !== null}
                                                        title={
                                                            PROJECT_ROLE_DESCRIPTIONS[
                                                                entry.role
                                                            ]
                                                        }
                                                        onChange={(event) => {
                                                            if (
                                                                isProjectRole(
                                                                    event.target
                                                                        .value,
                                                                )
                                                            )
                                                                void handleRoleChange(
                                                                    entryEmail,
                                                                    event.target
                                                                        .value,
                                                                );
                                                        }}
                                                        className={
                                                            ROLE_SELECT_CLASS
                                                        }
                                                    >
                                                        {PROJECT_ROLES.map(
                                                            (role) => (
                                                                <option
                                                                    key={role}
                                                                    value={role}
                                                                >
                                                                    {
                                                                        PROJECT_ROLE_LABELS[
                                                                            role
                                                                        ]
                                                                    }
                                                                </option>
                                                            ),
                                                        )}
                                                    </select>
                                                ) : (
                                                    <span
                                                        title={
                                                            PROJECT_ROLE_DESCRIPTIONS[
                                                                entry.role
                                                            ]
                                                        }
                                                        className="rounded-full px-2 py-1 text-xs text-gray-400"
                                                    >
                                                        {
                                                            PROJECT_ROLE_LABELS[
                                                                entry.role
                                                            ]
                                                        }
                                                    </span>
                                                )}
                                                {entry.effectiveRole && (
                                                    <span
                                                        title={`Their organization role already makes them ${PROJECT_ROLE_LABELS[entry.effectiveRole].toLowerCase()} here; a direct grant can add standing but never remove it.`}
                                                        className="shrink-0 whitespace-nowrap text-[10px] text-gray-400"
                                                    >
                                                        {
                                                            PROJECT_ROLE_LABELS[
                                                                entry
                                                                    .effectiveRole
                                                            ]
                                                        }{" "}
                                                        via organization
                                                    </span>
                                                )}
                                                {canManage && (
                                                    <>
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                setMemberMenuEmail(
                                                                    (current) =>
                                                                        current ===
                                                                        entryEmail
                                                                            ? null
                                                                            : entryEmail,
                                                                );
                                                            }}
                                                            disabled={
                                                                busy !== null
                                                            }
                                                            title="Member actions"
                                                            className={`flex h-6 items-center justify-center overflow-hidden rounded-full text-xs leading-none text-gray-500 transition-all hover:bg-gray-200/70 hover:text-gray-800 disabled:opacity-50 ${
                                                                memberMenuEmail ===
                                                                entryEmail
                                                                    ? "w-6 opacity-100"
                                                                    : "w-0 opacity-0 group-hover:w-6 group-hover:opacity-100"
                                                            }`}
                                                        >
                                                            ···
                                                        </button>
                                                        {memberMenuEmail ===
                                                            entryEmail && (
                                                            <div
                                                                className={`absolute right-0 top-full z-30 mt-1 min-w-28 overflow-hidden rounded-xl p-1 ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`}
                                                                onClick={(
                                                                    event,
                                                                ) =>
                                                                    event.stopPropagation()
                                                                }
                                                            >
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        void handleRemove(
                                                                            entryEmail,
                                                                        )
                                                                    }
                                                                    disabled={
                                                                        busy !==
                                                                        null
                                                                    }
                                                                    className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                                                                >
                                                                    {busy ===
                                                                        "remove" &&
                                                                        isPending && (
                                                                            <Loader2 className="h-3 w-3 animate-spin" />
                                                                        )}
                                                                    Remove
                                                                    access
                                                                </button>
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </div>
        </Modal>
    );
}

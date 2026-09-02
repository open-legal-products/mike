"use client";

import { useCallback, useEffect, useState } from "react";
import {
    Building2,
    Check,
    ChevronDown,
    Clock,
    Loader2,
    Mail,
    Plus,
    RotateCw,
    Users,
    X,
} from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { AddUserInput } from "@/app/components/shared/AddUserInput";
import { PillButton } from "@/app/components/ui/pill-button";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
    MikeApiError,
    acceptOrgInvitation,
    cancelOrgInvitation,
    createOrg,
    createOrgInvitation,
    declineOrgInvitation,
    listMyOrgInvitations,
    listOrgInvitations,
    listOrgMembers,
    listOrgs,
    removeOrgMember,
    resendOrgInvitation,
    updateOrgMember,
    type Org,
    type OrgInvitation,
    type OrgMember,
} from "@/app/lib/mikeApi";
import {
    ORG_ROLES,
    ORG_ROLE_DESCRIPTIONS,
    ORG_ROLE_LABELS,
    isOrgRole,
    type OrgRole,
} from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { SettingsSection } from "../SettingsSection";

function memberLabel(m: {
    display_name: string | null;
    email: string | null;
    user_id: string;
}): string {
    return m.display_name || m.email || m.user_id;
}

function formatDate(iso: string | null | undefined): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

/**
 * Turn a failed invitation call into a sentence the recipient can act on.
 *
 * Every one of these is an intentional server answer, not a crash: 410 for an
 * invitation whose window closed, 409 for one that was already answered or
 * duplicated, 404 for one that was cancelled out from under the page. Showing
 * the generic "something went wrong" for any of them would leave the user
 * re-clicking a button that can never succeed.
 */
function invitationErrorMessage(err: unknown, fallback: string): string {
    if (err instanceof MikeApiError) {
        if (err.status === 410)
            return "That invitation has expired. Ask an admin to send a new one.";
        if (err.status === 404)
            return "That invitation is no longer available. It may have been cancelled.";
    }
    return userFacingApiError(err, fallback);
}

function errorMessage(err: unknown): string {
    return userFacingApiError(err, "Something went wrong.");
}

export default function OrganizationsPage() {
    const { user } = useAuth();
    const [orgs, setOrgs] = useState<Org[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [newOrgName, setNewOrgName] = useState("");
    const [creatingOrg, setCreatingOrg] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const [openOrgId, setOpenOrgId] = useState<string | null>(null);
    const [invitations, setInvitations] = useState<OrgInvitation[] | null>(
        null,
    );

    const loadOrgs = useCallback(async () => {
        try {
            setOrgs(await listOrgs());
            setLoadError(null);
        } catch (err) {
            console.error("Failed to load organizations", err);
            setLoadError("Could not load organizations.");
        }
    }, []);

    const loadInvitations = useCallback(async () => {
        try {
            setInvitations(await listMyOrgInvitations());
        } catch (err) {
            console.error("Failed to load invitations", err);
            setInvitations([]);
        }
    }, []);

    useEffect(() => {
        void loadOrgs();
        void loadInvitations();
    }, [loadOrgs, loadInvitations]);

    async function handleCreateOrg() {
        const name = newOrgName.trim();
        if (!name || creatingOrg) return;
        setCreatingOrg(true);
        setCreateError(null);
        try {
            const org = await createOrg(name);
            setNewOrgName("");
            setOrgs((prev) => [...(prev ?? []), org]);
            setOpenOrgId(org.id);
        } catch (err) {
            setCreateError(errorMessage(err));
        } finally {
            setCreatingOrg(false);
        }
    }

    return (
        <div className="space-y-8">
            <section className="space-y-4">
                <div>
                    <h2 className="text-2xl font-medium font-serif">
                        Organizations
                    </h2>
                    <p className="mt-1 text-sm text-gray-600">
                        A project is either personal or belongs to an
                        organization. Organization admins administer the
                        organization&rsquo;s projects, organization members
                        collaborate on them, and anyone else can be invited to
                        a single project as an admin, member or viewer without
                        joining the organization.
                    </p>
                </div>

                <InvitationInbox
                    invitations={invitations}
                    onAnswered={() => {
                        void loadInvitations();
                        void loadOrgs();
                    }}
                />

                <SettingsSection>
                    <div className="p-4">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={newOrgName}
                                onChange={(e) => setNewOrgName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter")
                                        void handleCreateOrg();
                                }}
                                placeholder="New organization name…"
                                aria-label="New organization name"
                                className={cn(
                                    SETTINGS_CONTROL_CLASS,
                                    "h-10",
                                    "flex-1",
                                )}
                            />
                            <PillButton
                                tone="black"
                                size="sm"
                                onClick={() => void handleCreateOrg()}
                                disabled={!newOrgName.trim() || creatingOrg}
                            >
                                {creatingOrg ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Plus className="h-3.5 w-3.5" />
                                )}
                                Create organization
                            </PillButton>
                        </div>
                        {createError ? (
                            <p className="mt-2 text-xs text-red-500">
                                {createError}
                            </p>
                        ) : null}
                    </div>
                </SettingsSection>

                {loadError ? (
                    <p className="text-sm text-red-500">{loadError}</p>
                ) : orgs === null ? (
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading organizations…
                    </div>
                ) : orgs.length === 0 ? (
                    <p className="text-sm text-gray-600">
                        You are not part of any organization yet.
                    </p>
                ) : (
                    <div className="space-y-3">
                        {orgs.map((org) => (
                            <OrgCard
                                key={org.id}
                                org={org}
                                currentUserId={user?.id ?? null}
                                open={openOrgId === org.id}
                                onToggle={() =>
                                    setOpenOrgId((prev) =>
                                        prev === org.id ? null : org.id,
                                    )
                                }
                                onLeftOrg={() => {
                                    setOpenOrgId(null);
                                    void loadOrgs();
                                }}
                            />
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}

/**
 * The recipient's half of the invitation flow.
 *
 * It lives on this page rather than in a notification of its own because this
 * is where somebody goes to find out what organizations they are in, and an
 * invitation is the only way to be in one — nobody can be added directly.
 * Until it is accepted the invitation grants nothing, which is why the roles
 * are described here, before the decision, rather than after it.
 */
function InvitationInbox({
    invitations,
    onAnswered,
}: {
    invitations: OrgInvitation[] | null;
    onAnswered: () => void;
}) {
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    if (!invitations || invitations.length === 0) return null;

    async function answer(
        invitation: OrgInvitation,
        verb: "accept" | "decline",
    ) {
        if (busyId) return;
        setBusyId(invitation.id);
        setError(null);
        try {
            if (verb === "accept") await acceptOrgInvitation(invitation.id);
            else await declineOrgInvitation(invitation.id);
            onAnswered();
        } catch (err) {
            setError(
                invitationErrorMessage(
                    err,
                    verb === "accept"
                        ? "Could not accept that invitation."
                        : "Could not decline that invitation.",
                ),
            );
            // Whatever went wrong, the roster the page is showing is now
            // stale — re-read it so a dead invitation stops offering buttons.
            onAnswered();
        } finally {
            setBusyId(null);
        }
    }

    return (
        <SettingsSection>
            <div className="space-y-3 p-4">
                <h3 className="flex items-center gap-2 text-sm font-medium text-gray-700">
                    <Mail className="h-3.5 w-3.5" /> Invitations for you
                </h3>
                {error ? (
                    <p className="text-xs text-red-500">{error}</p>
                ) : null}
                <ul className="space-y-2">
                    {invitations.map((invitation) => (
                        <li
                            key={invitation.id}
                            className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-3"
                        >
                            <p className="text-sm text-gray-800">
                                {invitation.org_name ?? "An organization"}{" "}
                                invited you to join as{" "}
                                <span className="font-medium">
                                    {ORG_ROLE_LABELS[invitation.role]}
                                </span>
                                .
                            </p>
                            <p className="mt-0.5 text-xs text-gray-500">
                                {ORG_ROLE_DESCRIPTIONS[invitation.role]}
                            </p>
                            <p className="mt-0.5 text-xs text-gray-500">
                                {invitation.invited_by_email
                                    ? `Invited by ${invitation.invited_by_email}. `
                                    : ""}
                                Expires {formatDate(invitation.expires_at)}.
                            </p>
                            <div className="mt-2 flex items-center gap-2">
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    disabled={busyId === invitation.id}
                                    onClick={() =>
                                        void answer(invitation, "accept")
                                    }
                                >
                                    {busyId === invitation.id ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Check className="h-3.5 w-3.5" />
                                    )}
                                    Accept
                                </PillButton>
                                <PillButton
                                    tone="white"
                                    size="sm"
                                    disabled={busyId === invitation.id}
                                    onClick={() =>
                                        void answer(invitation, "decline")
                                    }
                                >
                                    Decline
                                </PillButton>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </SettingsSection>
    );
}

function OrgCard({
    org,
    currentUserId,
    open,
    onToggle,
    onLeftOrg,
}: {
    org: Org;
    currentUserId: string | null;
    open: boolean;
    onToggle: () => void;
    onLeftOrg: () => void;
}) {
    const isAdmin = org.role === "admin";
    const [members, setMembers] = useState<OrgMember[] | null>(null);
    const [invitations, setInvitations] = useState<OrgInvitation[] | null>(
        null,
    );
    const [inviteRole, setInviteRole] = useState<OrgRole>("member");
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [pendingRemove, setPendingRemove] = useState<OrgMember | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [memberRows, invitationRows] = await Promise.all([
                listOrgMembers(org.id),
                // The invitation roster is administrative detail; the server
                // refuses it to plain members, so don't ask on their behalf.
                isAdmin
                    ? listOrgInvitations(org.id)
                    : Promise.resolve([] as OrgInvitation[]),
            ]);
            setMembers(memberRows);
            setInvitations(invitationRows);
        } catch (err) {
            console.error("Failed to load organization detail", err);
            setError("Could not load this organization.");
        }
    }, [org.id, isAdmin]);

    useEffect(() => {
        if (open && members === null) void refresh();
    }, [open, members, refresh]);

    async function run(key: string, fn: () => Promise<void>): Promise<boolean> {
        // Returns whether the action ran to completion, so callers like
        // AddUserInput can keep their input when the action was skipped
        // (another one busy) or failed, instead of clearing it as if it
        // had succeeded.
        if (busyKey) return false;
        setBusyKey(key);
        setError(null);
        setNotice(null);
        try {
            await fn();
            return true;
        } catch (err) {
            setError(invitationErrorMessage(err, errorMessage(err)));
            return false;
        } finally {
            setBusyKey(null);
        }
    }

    // Only invitations still awaiting an answer belong in the roster: an
    // accepted one is a member row instead, and a declined or cancelled one
    // is history nobody needs to act on.
    const pendingInvitations = (invitations ?? []).filter(
        (invitation) => invitation.status === "pending",
    );
    const expiredInvitations = (invitations ?? []).filter(
        (invitation) => invitation.status === "expired",
    );

    return (
        <SettingsSection>
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full items-center gap-3 p-4 text-left"
                aria-expanded={open}
            >
                <Building2 className="h-4 w-4 text-gray-600" />
                <span className="flex-1 text-sm font-medium text-gray-800">
                    {org.name}
                </span>
                {typeof org.member_count === "number" ? (
                    <span className="text-xs text-gray-500">
                        {org.member_count}{" "}
                        {org.member_count === 1 ? "member" : "members"}
                    </span>
                ) : null}
                <RoleBadge role={org.role} />
                <ChevronDown
                    className={cn(
                        "h-4 w-4 text-gray-500 transition-transform",
                        open && "rotate-180",
                    )}
                />
            </button>

            {open ? (
                <div className="space-y-6 border-t border-gray-200/60 p-4">
                    {error ? (
                        <p className="text-xs text-red-500">{error}</p>
                    ) : null}
                    {notice ? (
                        <p className="text-xs text-gray-600">{notice}</p>
                    ) : null}

                    {isAdmin ? (
                        <div className="space-y-2">
                            <h3 className="flex items-center gap-2 text-sm font-medium text-gray-700">
                                <Mail className="h-3.5 w-3.5" /> Invite a
                                colleague
                            </h3>
                            <div className="flex max-w-md items-start gap-2">
                                <div className="min-w-0 flex-1">
                                    <AddUserInput
                                        placeholder="Invite by email…"
                                        submitLabel="Send invitation"
                                        busy={busyKey === "invite"}
                                        // The point of an invitation is to
                                        // reach somebody who is not here yet.
                                        requireExistingUser={false}
                                        onAdd={(u) =>
                                            run("invite", async () => {
                                                await createOrgInvitation(
                                                    org.id,
                                                    u.email,
                                                    inviteRole,
                                                );
                                                setNotice(
                                                    `Invitation sent to ${u.email}.`,
                                                );
                                                await refresh();
                                            })
                                        }
                                    />
                                </div>
                                <select
                                    aria-label="Role for the invitation"
                                    value={inviteRole}
                                    onChange={(e) => {
                                        if (isOrgRole(e.target.value))
                                            setInviteRole(e.target.value);
                                    }}
                                    disabled={busyKey === "invite"}
                                    className={cn(
                                        SETTINGS_CONTROL_CLASS,
                                        "h-10 w-28",
                                    )}
                                >
                                    {ORG_ROLES.map((role) => (
                                        <option key={role} value={role}>
                                            {ORG_ROLE_LABELS[role]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <p className="text-xs text-gray-500">
                                {ORG_ROLE_LABELS[inviteRole]}:{" "}
                                {ORG_ROLE_DESCRIPTIONS[inviteRole]} They join
                                only once they accept.
                            </p>
                        </div>
                    ) : null}

                    {isAdmin &&
                    (pendingInvitations.length > 0 ||
                        expiredInvitations.length > 0) ? (
                        <div className="space-y-2">
                            <h3 className="flex items-center gap-2 text-sm font-medium text-gray-700">
                                <Clock className="h-3.5 w-3.5" /> Pending
                                invitations
                            </h3>
                            <ul className="space-y-2">
                                {[
                                    ...pendingInvitations,
                                    ...expiredInvitations,
                                ].map((invitation) => (
                                    <li
                                        key={invitation.id}
                                        data-testid="pending-invitation"
                                        className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-gray-300 bg-gray-50/60 px-3 py-2"
                                    >
                                        <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                                            {invitation.email}
                                        </span>
                                        <span className="text-xs text-gray-500">
                                            {ORG_ROLE_LABELS[invitation.role]}
                                        </span>
                                        <span
                                            className={cn(
                                                "rounded-full px-2 py-0.5 text-xs",
                                                invitation.status === "expired"
                                                    ? "bg-red-50 text-red-600"
                                                    : "bg-amber-50 text-amber-700",
                                            )}
                                        >
                                            {invitation.status === "expired"
                                                ? "Expired"
                                                : "Pending"}
                                        </span>
                                        <span className="w-full text-xs text-gray-500">
                                            {invitation.invited_by_email
                                                ? `Invited by ${invitation.invited_by_email}. `
                                                : ""}
                                            {invitation.status === "expired"
                                                ? `Expired ${formatDate(invitation.expires_at)}. Resend to reopen it.`
                                                : `Expires ${formatDate(invitation.expires_at)}. No access until accepted.`}
                                        </span>
                                        <button
                                            type="button"
                                            aria-label={`Resend invitation to ${invitation.email}`}
                                            disabled={
                                                busyKey ===
                                                `resend-${invitation.id}`
                                            }
                                            onClick={() =>
                                                void run(
                                                    `resend-${invitation.id}`,
                                                    async () => {
                                                        const updated =
                                                            await resendOrgInvitation(
                                                                org.id,
                                                                invitation.id,
                                                            );
                                                        setNotice(
                                                            `Invitation to ${invitation.email} now expires ${formatDate(updated.expires_at)}.`,
                                                        );
                                                        await refresh();
                                                    },
                                                )
                                            }
                                            className="rounded p-1 text-gray-400 hover:bg-gray-200/70 hover:text-gray-700"
                                        >
                                            <RotateCw className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Cancel invitation to ${invitation.email}`}
                                            disabled={
                                                busyKey ===
                                                `cancel-${invitation.id}`
                                            }
                                            onClick={() =>
                                                void run(
                                                    `cancel-${invitation.id}`,
                                                    async () => {
                                                        await cancelOrgInvitation(
                                                            org.id,
                                                            invitation.id,
                                                        );
                                                        await refresh();
                                                    },
                                                )
                                            }
                                            className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}

                    <div className="space-y-3">
                        <h3 className="flex items-center gap-2 text-sm font-medium text-gray-700">
                            <Users className="h-3.5 w-3.5" /> Members
                        </h3>
                        {members === null ? (
                            <div className="flex items-center gap-2 text-xs text-gray-600">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Loading members…
                            </div>
                        ) : (
                            <ul className="space-y-1">
                                {members.map((m) => {
                                    const isSelf = m.user_id === currentUserId;
                                    return (
                                        <li
                                            key={m.user_id}
                                            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100/60"
                                        >
                                            <span className="flex-1 truncate">
                                                {memberLabel(m)}
                                                {isSelf ? (
                                                    <span className="ml-1 text-xs text-gray-500">
                                                        (You)
                                                    </span>
                                                ) : null}
                                            </span>
                                            {isAdmin && !isSelf ? (
                                                <select
                                                    aria-label={`Role for ${memberLabel(m)}`}
                                                    value={m.role}
                                                    disabled={
                                                        busyKey ===
                                                        `role-${m.user_id}`
                                                    }
                                                    onChange={(e) => {
                                                        const next =
                                                            e.target.value;
                                                        if (!isOrgRole(next))
                                                            return;
                                                        void run(
                                                            `role-${m.user_id}`,
                                                            async () => {
                                                                await updateOrgMember(
                                                                    org.id,
                                                                    m.user_id,
                                                                    next,
                                                                );
                                                                await refresh();
                                                            },
                                                        );
                                                    }}
                                                    className={cn(
                                                        SETTINGS_CONTROL_CLASS,
                                                        "w-28 py-1 text-xs",
                                                    )}
                                                    title={
                                                        ORG_ROLE_DESCRIPTIONS[
                                                            m.role
                                                        ]
                                                    }
                                                >
                                                    {ORG_ROLES.map((r) => (
                                                        <option
                                                            key={r}
                                                            value={r}
                                                        >
                                                            {ORG_ROLE_LABELS[r]}
                                                        </option>
                                                    ))}
                                                </select>
                                            ) : (
                                                <RoleBadge role={m.role} />
                                            )}
                                            {isSelf || isAdmin ? (
                                                <button
                                                    type="button"
                                                    aria-label={
                                                        isSelf
                                                            ? "Leave organization"
                                                            : `Remove ${memberLabel(m)}`
                                                    }
                                                    disabled={
                                                        busyKey ===
                                                        `remove-${m.user_id}`
                                                    }
                                                    onClick={() =>
                                                        setPendingRemove(m)
                                                    }
                                                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                                >
                                                    <X className="h-3.5 w-3.5" />
                                                </button>
                                            ) : null}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            ) : null}

            <ConfirmPopup
                open={pendingRemove !== null}
                title={
                    pendingRemove?.user_id === currentUserId
                        ? "Leave organization?"
                        : "Remove member?"
                }
                message={
                    pendingRemove
                        ? pendingRemove.user_id === currentUserId
                            ? `You will lose access to content shared in ${org.name}.`
                            : `${memberLabel(pendingRemove)} will lose access to content shared in ${org.name}.`
                        : ""
                }
                confirmLabel={
                    pendingRemove?.user_id === currentUserId
                        ? "Leave"
                        : "Remove"
                }
                confirmStatus={
                    busyKey === `remove-${pendingRemove?.user_id}`
                        ? "loading"
                        : "idle"
                }
                onCancel={() => setPendingRemove(null)}
                onConfirm={() => {
                    const target = pendingRemove;
                    if (!target) return;
                    // Close the popup whether or not the removal succeeded:
                    // the failure detail (e.g. the last-admin 409) renders in
                    // the card body, which the open modal would cover.
                    void run(`remove-${target.user_id}`, async () => {
                        await removeOrgMember(org.id, target.user_id);
                        if (target.user_id === currentUserId) onLeftOrg();
                        else await refresh();
                    }).finally(() => setPendingRemove(null));
                }}
            />
        </SettingsSection>
    );
}

function RoleBadge({ role }: { role: OrgRole }) {
    return (
        <span
            title={ORG_ROLE_DESCRIPTIONS[role]}
            className={cn(
                "rounded-full px-2 py-0.5 text-xs",
                role === "admin"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-600",
            )}
        >
            {ORG_ROLE_LABELS[role]}
        </span>
    );
}

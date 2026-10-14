"use client";

import { useEffect, useState } from "react";
import {
    getProjectPeople,
    listOrgMembers,
    type AccessAssignmentRole,
    type OrgMember,
    type UserLookupResult,
} from "@/app/lib/mikeApi";
import type { ContentVisibility } from "@/app/components/shared/types";
import { isOrgOwner, type ProjectRole } from "@/app/lib/permissions";
import {
    OrganizationAccessEditor,
    AccessEditor,
    type OrganizationAccessAssignment,
    type AccessRow,
} from "./AccessEditor";

export interface PendingDirectGrant {
    email: string;
    display_name: string | null;
    profile_photo?: string | null;
    role: ProjectRole;
}

export interface PendingOrgOverride {
    user_id: string;
    email: string;
    role: AccessAssignmentRole;
}

/**
 * Edits pending access choices before resource creation, retaining photos only from authorized rosters.
 * Unscoped email lookup supplies identity fields for monogram-only pending recipients.
 */
export function CreateAccessStep({
    orgId,
    organizationName,
    currentUserEmail,
    currentUserId,
    currentUserProfile: profile,
    directGrants,
    onDirectGrantsChange,
    orgOverrides = [],
    onOrgOverridesChange,
    inheritedFromProject = false,
    inheritedProjectId = null,
    ownerLabel = "Project owners",
    resourceNoun,
    visibility = "private",
}: {
    orgId: string | null;
    organizationName?: string | null;
    currentUserEmail?: string | null;
    currentUserId?: string | null;
    currentUserProfile?: { displayName?: string | null; profilePhoto?: string | null } | null;
    directGrants: PendingDirectGrant[];
    onDirectGrantsChange: (grants: PendingDirectGrant[]) => void;
    orgOverrides?: PendingOrgOverride[];
    onOrgOverridesChange?: (overrides: PendingOrgOverride[]) => void;
    inheritedFromProject?: boolean;
    /** The project whose people are shown, read-only, when access is inherited. */
    inheritedProjectId?: string | null;
    ownerLabel?: string;
    /** What the item is called where the step describes sharing it. */
    resourceNoun?: string;
    /**
     * For an organization's item: public or private, as chosen on the
     * details step. Decides whether individuals can be added here.
     */
    visibility?: ContentVisibility;
}) {
    const [memberState, setMemberState] = useState<{
        orgId: string;
        members: OrgMember[];
        error: string | null;
    } | null>(null);
    const [newRole, setNewRole] = useState<ProjectRole>("editor");
    const currentEmail = currentUserEmail?.trim().toLowerCase() ?? null;

    useEffect(() => {
        if (!orgId || inheritedFromProject) return;
        let cancelled = false;
        listOrgMembers(orgId)
            .then((rows) => {
                if (!cancelled) {
                    setMemberState({ orgId, members: rows, error: null });
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setMemberState({
                        orgId,
                        members: [],
                        error: "Could not load organization members.",
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [inheritedFromProject, orgId]);

    const [projectPeopleState, setProjectPeopleState] = useState<{
        projectId: string;
        rows: AccessRow[];
        error: string | null;
    } | null>(null);

    useEffect(() => {
        if (!inheritedFromProject || !inheritedProjectId) return;
        let cancelled = false;
        getProjectPeople(inheritedProjectId)
            .then((people) => {
                if (cancelled) return;
                const rows: AccessRow[] = [];
                if (people.owner) {
                    rows.push({
                        key: "creator",
                        user_id: people.owner.user_id,
                        email: people.owner.email,
                        display_name: people.owner.display_name,
                        profile_photo: people.owner.profile_photo,
                        role: "owner",
                        isCreator: true,
                    });
                }
                for (const member of people.members) {
                    // A denied organization member has no access to show.
                    if (member.role === "deny") continue;
                    rows.push({
                        key: member.user_id ?? member.email,
                        user_id: member.user_id ?? null,
                        email: member.email,
                        display_name: member.display_name,
                        profile_photo: member.profile_photo,
                        role: member.role ?? "editor",
                    });
                }
                setProjectPeopleState({
                    projectId: inheritedProjectId,
                    rows,
                    error: null,
                });
            })
            .catch(() => {
                if (!cancelled) {
                    setProjectPeopleState({
                        projectId: inheritedProjectId,
                        rows: [],
                        error: "Could not load the project's members.",
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [inheritedFromProject, inheritedProjectId]);

    const projectPeople =
        inheritedFromProject &&
        !!inheritedProjectId &&
        projectPeopleState?.projectId === inheritedProjectId
            ? projectPeopleState
            : null;
    const loadingProjectPeople =
        inheritedFromProject && !!inheritedProjectId && !projectPeople;

    const hasLoadedCurrentOrg = !!orgId && memberState?.orgId === orgId;
    const members = hasLoadedCurrentOrg ? memberState.members : [];
    const loading = !!orgId && !inheritedFromProject && !hasLoadedCurrentOrg;
    const loadError = hasLoadedCurrentOrg ? memberState.error : null;

    const rows: AccessRow[] = inheritedFromProject
        ? (projectPeople?.rows ?? [])
        : [
                ...(currentEmail
                    ? [
                          {
                              key: "creator",
                              email: currentEmail,
                              display_name: profile?.displayName ?? null,
                              profile_photo: profile?.profilePhoto,
                              role: "owner" as const,
                              isCreator: true,
                          },
                      ]
                    : []),
                ...directGrants.map((grant) => ({
                    key: grant.email,
                    email: grant.email,
                    display_name: grant.display_name,
                    profile_photo: grant.profile_photo,
                    role: grant.role,
                })),
            ];

    const organizationMembers: AccessRow[] = members.map((member) => {
        const isCreator =
            (!!currentUserId && member.user_id === currentUserId) ||
            (!!currentEmail &&
                member.email?.trim().toLowerCase() === currentEmail);
        return {
            key: member.user_id,
            user_id: member.user_id,
            email: member.email,
            display_name: member.display_name,
            profile_photo: member.profile_photo,
            // Marked so the editor can leave the organization's owners out
            // of a public item's pickers: they own those already. A private
            // item is shared with them like with anyone.
            role: isOrgOwner(member.role) ? "owner" : "editor",
            isCreator,
        };
    });
    const overrideAssignments: OrganizationAccessAssignment[] = orgOverrides.map((override) => {
        const member = members.find(
            (entry) => entry.user_id === override.user_id,
        );
        return {
            key: override.user_id,
            user_id: override.user_id,
            email: override.email,
            display_name: member?.display_name ?? null,
            profile_photo: member?.profile_photo,
            role: override.role,
        };
    });
    const creator = organizationMembers.find((member) => member.isCreator);
    const organizationAssignments: OrganizationAccessAssignment[] = [
        ...(creator
            ? [
                  {
                      ...creator,
                      role: "owner" as const,
                      isCreator: true,
                  },
              ]
            : []),
        ...overrideAssignments.filter(
            (assignment) => assignment.user_id !== creator?.user_id,
        ),
    ];

    function validateDirectEmail(email: string) {
        if (currentEmail && email === currentEmail)
            return "You are already the owner.";
        if (directGrants.some((grant) => grant.email === email))
            return `${email} already has access.`;
        return null;
    }

    function addDirect(user: UserLookupResult) {
        const email = user.email.trim().toLowerCase();
        onDirectGrantsChange([
            ...directGrants,
            { email, display_name: user.display_name, role: newRole },
        ]);
    }

    function changeRole(row: AccessRow, role: AccessAssignmentRole) {
        if (!row.email || role === "deny") return;
        onDirectGrantsChange(
            directGrants.map((grant) =>
                grant.email === row.email ? { ...grant, role } : grant,
            ),
        );
    }

    function assignOrganizationMember(
        member: AccessRow,
        role: AccessAssignmentRole,
    ) {
        if (!member.user_id || !member.email) return;
        onOrgOverridesChange?.([
            ...orgOverrides.filter(
                (override) => override.user_id !== member.user_id,
            ),
            {
                user_id: member.user_id,
                email: member.email,
                role,
            },
        ]);
    }

    if (orgId && !inheritedFromProject) {
        return (
            <OrganizationAccessEditor
                members={organizationMembers}
                assignments={organizationAssignments}
                organizationName={organizationName}
                ownerLabel={ownerLabel}
                resourceNoun={resourceNoun}
                loading={loading}
                error={loadError}
                currentUserId={currentUserId}
                currentUserEmail={currentUserEmail}
                visibility={visibility}
                onAssign={assignOrganizationMember}
                onRemove={(assignment) =>
                    onOrgOverridesChange?.(
                        orgOverrides.filter(
                            (override) =>
                                override.user_id !== assignment.user_id,
                        ),
                    )
                }
            />
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <AccessEditor
                scope={inheritedFromProject ? "project" : "direct"}
                rows={rows}
                loading={loading || loadingProjectPeople}
                canManage={!inheritedFromProject}
                currentUserEmail={currentUserEmail}
                currentUserId={currentUserId}
                newRole={newRole}
                onNewRoleChange={setNewRole}
                onAdd={!inheritedFromProject ? addDirect : undefined}
                validateEmail={validateDirectEmail}
                onRoleChange={!inheritedFromProject ? changeRole : undefined}
                onRemove={(row) =>
                    onDirectGrantsChange(
                        directGrants.filter((grant) => grant.email !== row.email),
                    )
                }
                error={projectPeople?.error ?? loadError}
            />
        </div>
    );
}

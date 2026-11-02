"use client";

import { useEffect, useRef, useState } from "react";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { storeWorkspace } from "@/app/contexts/WorkspaceContext";
import { notifyOrganizationInvitationsChanged } from "@/app/hooks/useOrganizationInvitationCount";
import {
    acceptOrgInvitation,
    listMyOrgInvitations,
    type OrgInvitation,
} from "@/app/lib/mikeApi";
import { ORG_ROLE_LABELS, type OrgRole } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

/** The authenticated endpoint only exposes invitations for a verified email. */
export function OnboardingInvitations({
    userId,
    disabled,
    onBusyChange,
}: {
    userId: string;
    disabled: boolean;
    onBusyChange: (busy: boolean) => void;
}) {
    const [invitations, setInvitations] = useState<OrgInvitation[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [answerError, setAnswerError] = useState<string | null>(null);
    const [answeringId, setAnsweringId] = useState<string | null>(null);
    const [joined, setJoined] = useState<Record<string, OrgRole>>({});
    const [attempt, setAttempt] = useState(0);
    const mounted = useRef(false);
    const accepting = useRef(false);

    useEffect(() => {
        mounted.current = true;
        let cancelled = false;
        onBusyChange(true);
        void listMyOrgInvitations().then((items) => {
            if (!cancelled) setInvitations(items);
        }, (error) => {
            if (!cancelled) setLoadError(userFacingApiError(error, "Could not load your invitations."));
        }).finally(() => {
            if (!cancelled) onBusyChange(false);
        });
        return () => { cancelled = true; mounted.current = false; };
    }, [attempt, onBusyChange, userId]);

    function reload() {
        setInvitations(null);
        setLoadError(null);
        setAnswerError(null);
        onBusyChange(true);
        setAttempt((current) => current + 1);
    }

    async function accept(invitation: OrgInvitation) {
        if (disabled || accepting.current) return;
        accepting.current = true;
        setAnsweringId(invitation.id);
        setAnswerError(null);
        onBusyChange(true);
        try {
            const accepted = await acceptOrgInvitation(invitation.id);
            if (!mounted.current) return;
            storeWorkspace(userId, accepted.org_id);
            setJoined((current) => ({ ...current, [invitation.id]: accepted.role }));
            notifyOrganizationInvitationsChanged();
        } catch (error) {
            if (mounted.current) setAnswerError(userFacingApiError(error, "Could not accept this invitation. Please try again."));
        } finally {
            accepting.current = false;
            if (mounted.current) { setAnsweringId(null); onBusyChange(false); }
        }
    }

    return (
        <section aria-label="Organization invitations" className="space-y-3">
            {invitations?.length === 0 && !loadError ? (
                <p role="status" className="text-sm text-gray-500">You have no pending invitations. You can join an organization later from Settings.</p>
            ) : null}
            {invitations === null && !loadError ? (
                <GlassCardUI>
                    <div role="status" aria-label="Checking your invitations" className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <SkeletonLine className="h-9 w-9 shrink-0" />
                        <div className="min-w-0 flex-1 space-y-2"><SkeletonLine className="w-32 max-w-full" /><SkeletonLine className="w-24 max-w-full" /></div>
                        <SkeletonLine className="h-7 w-16" />
                    </div>
                </GlassCardUI>
            ) : null}
            {loadError || answerError ? (
                <div className="space-y-2">
                    <p role="alert" className="text-sm text-red-600">{loadError || answerError}</p>
                    <PillButtonUI type="button" tone="white" size="sm" disabled={disabled || answeringId !== null} onClick={reload}>
                        {loadError ? "Try again" : "Refresh invitations"}
                    </PillButtonUI>
                </div>
            ) : null}
            {invitations?.map((invitation) => {
                const name = invitation.org_name || "Organization";
                const joinedRole = joined[invitation.id];
                return (
                    <ConnectorCard key={invitation.id} kind="invitation" name={name}
                        icon={<OrganizationSkeuoIcon className="h-6 w-6" />}
                        detail={<>
                            <span className="block [overflow-wrap:anywhere]">{joinedRole ? "Joined as" : "Invited as"} {ORG_ROLE_LABELS[joinedRole ?? invitation.role]}</span>
                            {invitation.invited_by_email ? <span className="block [overflow-wrap:anywhere]">From {invitation.invited_by_email}</span> : null}
                        </>}
                        action={joinedRole ? (
                            <span role="status" className="text-xs font-medium text-gray-500">Joined</span>
                        ) : (
                            <PillButtonUI type="button" tone="blue" size="sm" aria-label={`Accept ${name}`}
                                disabled={disabled || answeringId !== null}
                                loading={answeringId === invitation.id} onClick={() => void accept(invitation)}>Accept</PillButtonUI>
                        )}
                    />
                );
            })}
            {Object.keys(joined).length > 0 ? (
                <p role="status" className="text-xs text-gray-500">Invitation accepted. Finish setup to open your organization workspace.</p>
            ) : null}
        </section>
    );
}

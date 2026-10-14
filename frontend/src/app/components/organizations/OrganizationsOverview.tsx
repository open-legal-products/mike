"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { notifyOrganizationInvitationsChanged } from "@/app/hooks/useOrganizationInvitationCount";
import {
  acceptOrgInvitation,
  declineOrgInvitation,
  listMyOrgInvitations,
  listOrgs,
  type Org,
  type OrgInvitation,
} from "@/app/lib/mikeApi";
import { ORG_ROLE_LABELS } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@/shared/ui/LiquidGlassUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { DeletedOrganizations } from "./DeletedOrganizations";
import { CreateOrganizationModal } from "./OrganizationModals";
import { organizationSettingsHref } from "./OrganizationSettingsShell";

/** Organizations follow the two-column settings card layout. */
const CARD_GRID_CLASS = "grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2";

/**
 * The Organizations section of a person's settings: the organizations they
 * belong to, the invitations waiting for them, and a way to start a new
 * one. Set as settings cards, like Connectors and Bring Your Own Keys.
 *
 * An organization's settings belong to its workspace, so only the card of the
 * workspace the person is in has a Manage button. Every other organization
 * offers a switch to its workspace instead, from where its settings open.
 */
export function OrganizationsOverview() {
  const router = useRouter();
  const { workspaceId, setWorkspace, refreshOrganizations } = useWorkspace();
  // `null` is "no workspace to compare with" (outside a WorkspaceProvider),
  // where nothing is narrowed.
  const isCurrentWorkspace = (org: Org) =>
    workspaceId === null || workspaceId === org.id;
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);

  // The two lists fail independently: a broken invitations fetch must not
  // blank the organizations table, and — the reason this is not a swallowed
  // `.catch(() => [])` — it must not masquerade as "you have no invitations"
  // either. Each side keeps its own error so each can offer its own retry.
  const load = useCallback(async () => {
    const [orgsResult, invitationsResult] = await Promise.allSettled([
      listOrgs(),
      listMyOrgInvitations(),
    ]);
    if (orgsResult.status === "fulfilled") {
      setOrgs(orgsResult.value);
      setLoadError(null);
    } else {
      console.error("Failed to load organizations", orgsResult.reason);
      // The invitations half of this same function already routes its
      // failure through userFacingApiError, which shows the server's own
      // wording for a 4xx. A hardcoded sentence here threw that away, so the
      // two halves of one screen answered the same kind of failure
      // differently — and the more useful answer was the one discarded.
      setLoadError(
        userFacingApiError(orgsResult.reason, "Could not load organizations."),
      );
      setOrgs([]);
    }
    if (invitationsResult.status === "fulfilled") {
      setInvitations(invitationsResult.value);
      setInvitationsError(null);
    } else {
      console.error("Failed to load invitations", invitationsResult.reason);
      setInvitations([]);
      setInvitationsError(
        userFacingApiError(
          invitationsResult.reason,
          "Could not load your invitations.",
        ),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function answer(invitation: OrgInvitation, accept: boolean) {
    setAnsweringId(invitation.id);
    setInvitationError(null);
    try {
      if (accept) await acceptOrgInvitation(invitation.id);
      else await declineOrgInvitation(invitation.id);
    } catch (error) {
      setInvitationError(
        userFacingApiError(error, "Could not answer that invitation."),
      );
    } finally {
      setAnsweringId(null);
    }
    // Outside the try, and on both paths. Inside it, a re-read that failed
    // would have been reported as "Could not answer that invitation" about an
    // invitation the server had just accepted — the reload is bookkeeping,
    // not the user's action. Both paths need it: an accepted invitation moves
    // to the organizations list, and a refusal is often a refusal because
    // somebody answered it somewhere else already.
    await load();
    notifyOrganizationInvitationsChanged();
    // An accepted invitation is a new workspace to switch to.
    void refreshOrganizations();
  }

  const loading = orgs === null;
  // The workspace the person is in comes first; the rest follow by name.
  const listedOrgs = useMemo(
    () =>
      [...(orgs ?? [])].sort(
        (a, b) =>
          Number(isCurrentWorkspace(b)) - Number(isCurrentWorkspace(a)) ||
          a.name.localeCompare(b.name),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isCurrentWorkspace reads only workspaceId
    [orgs, workspaceId],
  );

  return (
    <div className="@container space-y-6">
      <section aria-labelledby="my-organizations-heading">
        <div className="mb-4 flex items-center justify-between gap-3">
          <SettingsHeading id="my-organizations-heading">
            Organizations
          </SettingsHeading>
          <PillButtonUI
            tone="white"
            size="xs"
            onClick={() => setCreateOpen(true)}
            aria-label="New organization"
            aria-haspopup="dialog"
            className={`h-7 ${LIQUID_GLASS_SUBTLE_CLASS}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New
          </PillButtonUI>
        </div>
        {loading ? (
          <div className={CARD_GRID_CLASS} aria-busy="true">
            {[1, 2].map((placeholder) => (
              <GlassCardUI key={placeholder}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-gray-200" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <span className="block h-4 w-32 max-w-full animate-pulse rounded bg-gray-200" />
                    <span className="block h-3 w-24 max-w-full animate-pulse rounded bg-gray-200" />
                  </div>
                </div>
              </GlassCardUI>
            ))}
          </div>
        ) : loadError ? (
          <GlassCardUI>
            <div className="flex flex-wrap items-center gap-3 p-4" role="alert">
              <div className="min-w-0 flex-1">
                <SettingsDescription>{loadError}</SettingsDescription>
              </div>
              <PillButtonUI tone="white" size="sm" onClick={() => void load()}>
                Try again
              </PillButtonUI>
            </div>
          </GlassCardUI>
        ) : listedOrgs.length === 0 ? (
          <SettingsDescription>
            No organizations yet. Create one to share projects and
            workflows with your team.
          </SettingsDescription>
        ) : (
          <div className={CARD_GRID_CLASS}>
            {listedOrgs.map((org) => {
              const current = isCurrentWorkspace(org);
              const members = org.member_count ?? 0;
              return (
                <ConnectorCard
                  key={org.id}
                  kind="organization"
                  name={org.name}
                  detail={`${ORG_ROLE_LABELS[org.role]} · ${members} ${
                    members === 1 ? "member" : "members"
                  }`}
                  icon={<OrganizationSkeuoIcon className="h-6 w-6" />}
                  // Only the workspace the person is in opens its settings;
                  // every other organization is switched to first.
                  action={
                    current ? (
                      <PillButtonUI
                        tone="blue"
                        size="sm"
                        aria-label={`Manage ${org.name}`}
                        onClick={() =>
                          router.push(organizationSettingsHref(org.id))
                        }
                      >
                        Manage
                      </PillButtonUI>
                    ) : (
                      <PillButtonUI
                        tone="black"
                        size="sm"
                        aria-label={`Switch to ${org.name}`}
                        onClick={() => setWorkspace(org.id)}
                      >
                        Switch
                      </PillButtonUI>
                    )
                  }
                />
              );
            })}
          </div>
        )}
      </section>

      {/* Shown only when there is something to answer, or the list of
          invitations could not be read: an empty inbox needs no section. */}
      {invitationsError || invitations.length > 0 ? (
        <section aria-labelledby="my-invitations-heading">
          <div className="mb-4">
            <SettingsHeading id="my-invitations-heading">
              Invitations
            </SettingsHeading>
          </div>
          {invitationsError ? (
            <GlassCardUI>
              <div
                className="flex flex-wrap items-center gap-3 p-4"
                role="alert"
              >
                <div className="min-w-0 flex-1">
                  <SettingsDescription>{invitationsError}</SettingsDescription>
                </div>
                <PillButtonUI
                  tone="white"
                  size="sm"
                  onClick={() => void load()}
                >
                  Try again
                </PillButtonUI>
              </div>
            </GlassCardUI>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {invitations.map((invitation) => {
                const name = invitation.org_name ?? "An organization";
                const answering = answeringId === invitation.id;
                return (
                  <ConnectorCard
                    key={invitation.id}
                    kind="invitation"
                    name={name}
                    detail={`Invited you as ${ORG_ROLE_LABELS[invitation.role]}`}
                    icon={<OrganizationSkeuoIcon className="h-6 w-6" />}
                    action={
                      <span className="flex items-center gap-2">
                        <PillButtonUI
                          tone="white"
                          size="sm"
                          disabled={answering}
                          aria-label={`Decline ${name}`}
                          onClick={() => void answer(invitation, false)}
                        >
                          Decline
                        </PillButtonUI>
                        <PillButtonUI
                          tone="blue"
                          size="sm"
                          disabled={answering}
                          loading={answering}
                          aria-label={`Accept ${name}`}
                          onClick={() => void answer(invitation, true)}
                        >
                          Accept
                        </PillButtonUI>
                      </span>
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      <DeletedOrganizations onRestored={load} />
      <CreateOrganizationModal
        open={createOpen}
        // A partly failed creation ("created, but some invitations could not
        // be sent") leaves the modal open on a real organization that never
        // reached onCreated. Refetching on dismissal is what makes that
        // organization appear here instead of only after a reload.
        onClose={() => {
          setCreateOpen(false);
          void load();
        }}
        onCreated={() => {
          setCreateOpen(false);
          // A new workspace to switch to; its settings open from there. It
          // appears in this list, and in the account menu's switcher.
          void load();
          void refreshOrganizations();
        }}
      />
      <WarningPopup
        open={invitationError !== null}
        title="Invitation not updated"
        message={invitationError}
        onClose={() => setInvitationError(null)}
      />
    </div>
  );
}

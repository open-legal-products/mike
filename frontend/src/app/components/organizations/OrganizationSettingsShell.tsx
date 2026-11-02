"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { TableEmptyState } from "@/app/components/shared/TablePrimitive";
import {
  SettingsShell,
  type SettingsShellTab,
} from "@/app/components/settings/SettingsShell";
import { EmptyState } from "@/app/components/ui/empty-state";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { useItemWorkspace } from "@/app/hooks/useItemWorkspace";
import { getOrg, type Org } from "@/app/lib/mikeApi";
import { isOrgAdmin, isOrgOwner } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

// An organization's settings area: the same frame as a person's settings,
// with its sections down the side.
//
//   General          everyone in the organization
//   Members          everyone in the organization; a full table page of its
//                    own rather than a section inside the frame
//   Bring Your Own Keys  its owners and admins: the organization's model
//                        provider keys, as in a person's own settings
//
// An organization's settings are part of its workspace: they open only while
// that organization is the caller's active workspace, never from another
// organization's or from personal work. Opening them from elsewhere — a
// link, the browser's history — switches to that workspace, with a notice
// (useItemWorkspace); nothing about the organization is read until it has.
// Switching workspace with them open leaves for the new workspace's home.
//
// OrganizationSettingsProvider loads the organization once and hands it to
// every page under settings, so they agree about the name and about what the
// caller may do. OrganizationSettingsFrame is the sectioned frame around the
// pages that sit inside it. The server still decides every change; a section
// a member cannot use is not offered.

interface OrganizationSettingsContextValue {
  orgId: string;
  /** `null` until the organization has loaded. */
  org: Org | null;
  /** Put a changed organization (a new name) in place without a re-read. */
  setOrg: (org: Org) => void;
  /** Re-read the organization, after the caller's role may have changed. */
  reload: () => Promise<void>;
}

const OrganizationSettingsContext =
  createContext<OrganizationSettingsContextValue | null>(null);

export function useOrganizationSettings(): OrganizationSettingsContextValue {
  const value = useContext(OrganizationSettingsContext);
  if (!value)
    throw new Error(
      "useOrganizationSettings must be used inside OrganizationSettingsShell",
    );
  return value;
}

export function organizationSettingsHref(
  orgId: string,
  section: OrganizationSettingsSection = "general",
): string {
  const root = `/organizations/${orgId}/settings`;
  return section === "general" ? root : `${root}/${section}`;
}

type OrganizationSettingsSection =
  "general" | "members" | "audit" | "providers" | "privacy-data";

export function OrganizationSettingsProvider({
  orgId,
  children,
}: {
  orgId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { workspaceId, organizations } = useWorkspace();
  const [org, setOrg] = useState<Org | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // `null` is "no workspace to compare with" (outside a WorkspaceProvider),
  // where nothing is narrowed.
  const inWorkspace = workspaceId === null || workspaceId === orgId;
  // Opening an organization's settings opens its workspace.
  useItemWorkspace(orgId, orgId);

  const reload = useCallback(async () => {
    // Another workspace's settings are not read at all.
    if (!inWorkspace) return;
    try {
      setOrg(await getOrg(orgId));
      setLoadError(null);
    } catch (error) {
      setLoadError(
        userFacingApiError(error, "Could not load this organization."),
      );
    }
  }, [inWorkspace, orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start the organization request once its id is known
    void reload();
  }, [reload]);

  const value = useMemo(
    () => ({ orgId, org, setOrg, reload }),
    [orgId, org, reload],
  );

  if (!inWorkspace) {
    // Whether it is one of theirs can only be said once the caller's own
    // organizations are known.
    if (organizations === null) return null;
    // Theirs: its workspace is on the way in, or they have just switched
    // out of it and are on the way to the other one's home.
    if (organizations.some((candidate) => candidate.id === orgId)) return null;
    // Not one of theirs: say nothing about it, as a 404 would.
    return (
      <TableEmptyState>
        <EmptyState
          icon={<OrganizationSkeuoIcon />}
          title="Organization"
          description="These settings are not available."
          action={
            <PillButtonUI
              tone="white"
              size="sm"
              onClick={() => router.push("/settings/organizations")}
            >
              Your organizations
            </PillButtonUI>
          }
        />
      </TableEmptyState>
    );
  }

  // Somebody who is not in the organization is told nothing about it, and a
  // failed read has no pages to show: either way there is no area to frame,
  // only the message and a retry.
  if (loadError && !org)
    return (
      <TableEmptyState>
        <EmptyState
          icon={<OrganizationSkeuoIcon />}
          title="Organization"
          description={loadError}
          tone="error"
          action={
            <PillButtonUI
              tone="black"
              size="sm"
              onClick={() => {
                setLoadError(null);
                void reload();
              }}
            >
              Try again
            </PillButtonUI>
          }
        />
      </TableEmptyState>
    );

  return (
    <OrganizationSettingsContext.Provider value={value}>
      {children}
    </OrganizationSettingsContext.Provider>
  );
}

/** The sectioned frame around the settings pages that sit inside it. */
export function OrganizationSettingsFrame({
  children,
}: {
  children: ReactNode;
}) {
  const { orgId, org } = useOrganizationSettings();
  const canManage = org !== null && isOrgAdmin(org.role);
  const isOwner = org !== null && isOrgOwner(org.role);
  const tabs = useMemo<SettingsShellTab[]>(
    () => [
      {
        id: "general",
        label: "General",
        href: organizationSettingsHref(orgId),
      },
      // A table page of its own; its header leads back here.
      {
        id: "members",
        label: "Members",
        href: organizationSettingsHref(orgId, "members"),
      },
      // Not offered to a member, nor before the caller's role is known.
      ...(canManage
        ? [
            {
              id: "audit",
              label: "Audit log",
              href: organizationSettingsHref(orgId, "audit"),
            },
            {
              id: "providers",
              // Named as the same setting is in a person's own settings.
              label: "Bring Your Own Keys",
              href: organizationSettingsHref(orgId, "providers"),
            },
          ]
        : []),
      // Its actions reach every member's work, so it is its owners' alone.
      ...(isOwner
        ? [
            {
              id: "privacy-data",
              // Named as the same page is in a person's own settings.
              label: "Privacy & Data",
              href: organizationSettingsHref(orgId, "privacy-data"),
            },
          ]
        : []),
    ],
    [canManage, isOwner, orgId],
  );

  return (
    <SettingsShell
      title="Organization"
      navLabel="Organization"
      tabs={tabs}
      rootHref={organizationSettingsHref(orgId)}
    >
      {children}
    </SettingsShell>
  );
}

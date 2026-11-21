"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { EmptyState } from "@/app/components/ui/empty-state";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
  deleteOrgData,
  isMfaRequiredError,
  setOrgMemberDataPolicy,
  type OrgDataKind,
  type OrgMemberDataPolicy,
} from "@/app/lib/mikeApi";
import { isOrgOwner } from "@/app/lib/permissions";
import { notifyError } from "@/app/lib/userFacingError";
import { GlassCardUI, PillButtonUI, ToggleSwitchUI } from "@mike/ui";
import {
  organizationSettingsHref,
  useOrganizationSettings,
} from "./OrganizationSettingsShell";

// The Privacy & Data section of an organization's settings: the
// organization-wide twin of a person's own Privacy & Data page. Each action
// reaches every member's work in the organization, so the section is its
// owners' alone; the server refuses anyone else.

const DELETE_ROWS: {
  kind: OrgDataKind;
  label: string;
  description: string;
  title: string;
  message: string;
}[] = [
  {
    kind: "chats",
    label: "Delete all chats",
    description:
      "Permanently delete the organization's assistant, project and tabular review chat history.",
    title: "Delete all organization chats?",
    message:
      "This will permanently delete assistant, project and tabular review chat history across the organization, for every member. Consider exporting anything you need to keep first. This action cannot be undone.",
  },
  {
    kind: "tabular-reviews",
    label: "Delete all tabular reviews",
    description:
      "Permanently delete every tabular review in the organization, including cells and review chats.",
    title: "Delete all organization tabular reviews?",
    message:
      "This will permanently delete every tabular review in the organization, including their cells and review chats, for every member. Consider exporting anything you need to keep first. This action cannot be undone.",
  },
  {
    kind: "projects",
    label: "Delete all projects",
    description:
      "Permanently delete every project in the organization, including documents, chats, and tabular reviews.",
    title: "Delete all organization projects?",
    message:
      "This will permanently delete every project in the organization, including their documents, chats, and tabular reviews, for every member. Consider exporting anything you need to keep first. This action cannot be undone.",
  },
  {
    kind: "playbooks",
    label: "Delete all playbooks",
    description:
      "Permanently delete every playbook in the organization, including review history and reference documents.",
    title: "Delete all organization playbooks?",
    message:
      "This will permanently delete every playbook in the organization, public and private, including their review history and reference documents, for every member. Consider exporting anything you need to keep first. This action cannot be undone.",
  },
  {
    kind: "memories",
    label: "Delete all memory",
    description:
      "Permanently delete the memory of every project in the organization.",
    title: "Delete all organization memory?",
    message:
      "This permanently deletes the memory of every project in the organization. Memory remains enabled and can be rebuilt from future conversations. This action cannot be undone.",
  },
];

const POLICY_ROWS: {
  key: keyof OrgMemberDataPolicy;
  label: string;
  description: (orgName: string) => string;
}[] = [
  {
    key: "allow_member_exports",
    label: "Let members export their data",
    description: (orgName) =>
      `Members can export their own chats, tabular reviews, projects and memory in ${orgName} from Settings › Privacy & Data. Owners always can.`,
  },
  {
    key: "allow_member_deletes",
    label: "Let members delete their data in bulk",
    description: (orgName) =>
      `Members can delete all of their own chats, tabular reviews, projects or memory in ${orgName} at once. Deleting one item at a time is not affected.`,
  },
];

/**
 * Whether members may export, and bulk-delete, their own work here. Both
 * start off; when neither is allowed, members do not see Privacy & Data in
 * this organization's workspace at all.
 */
function MemberDataPolicySection() {
  const { orgId, org, setOrg } = useOrganizationSettings();
  const { refreshOrganizations } = useWorkspace();
  const [savingKey, setSavingKey] = useState<keyof OrgMemberDataPolicy | null>(
    null,
  );
  // A change the server asked a second factor for, to send again after it.
  const [pendingMfa, setPendingMfa] = useState<{
    next: OrgMemberDataPolicy;
    key: keyof OrgMemberDataPolicy;
  } | null>(null);
  const policy: OrgMemberDataPolicy = {
    allow_member_exports: org?.allow_member_exports === true,
    allow_member_deletes: org?.allow_member_deletes === true,
  };

  async function save(next: OrgMemberDataPolicy, key: keyof OrgMemberDataPolicy) {
    setSavingKey(key);
    try {
      const saved = await setOrgMemberDataPolicy(orgId, next);
      if (org) setOrg({ ...org, ...saved });
      // Members' own Settings follow the organization list.
      void refreshOrganizations();
    } catch (error) {
      if (isMfaRequiredError(error)) setPendingMfa({ next, key });
      else
        notifyError(error, {
          action: "change what members can do with their data",
          onRetry: () => void save(next, key),
        });
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section aria-labelledby="org-privacy-members" className="space-y-3">
      <SettingsHeading id="org-privacy-members">Members&apos; data</SettingsHeading>
      <GlassCardUI>
        {POLICY_ROWS.map((row) => (
          <SettingsRow key={row.key}>
            <div className="space-y-1">
              <SettingsLabel>{row.label}</SettingsLabel>
              <SettingsDescription>
                {row.description(org?.name ?? "this organization")}
              </SettingsDescription>
            </div>
            <ToggleSwitchUI
              checked={policy[row.key]}
              aria-label={row.label}
              disabled={!org || savingKey !== null}
              onCheckedChange={(checked) =>
                void save({ ...policy, [row.key]: checked }, row.key)
              }
              className="shrink-0"
            />
          </SettingsRow>
        ))}
      </GlassCardUI>
      <MfaVerificationPopup
        open={pendingMfa !== null}
        onCancel={() => setPendingMfa(null)}
        onVerified={() => {
          const pending = pendingMfa;
          setPendingMfa(null);
          if (pending) void save(pending.next, pending.key);
        }}
        title="Two-factor verification required"
        message="This setting is sensitive. Enter a code from your authenticator app to continue."
      />
    </section>
  );
}

export function OrganizationPrivacyData() {
  const router = useRouter();
  const { orgId, org } = useOrganizationSettings();
  const { loadChats, setCurrentChatId } = useChatHistoryContext();
  const [pendingKind, setPendingKind] = useState<OrgDataKind | null>(null);
  const [deletingKind, setDeletingKind] = useState<OrgDataKind | null>(null);
  const [mfaKind, setMfaKind] = useState<OrgDataKind | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);

  if (org && !isOrgOwner(org.role))
    return (
      <EmptyState
        icon={<OrganizationSkeuoIcon />}
        title="Privacy & Data"
        description="Only this organization's owners can manage its data."
        action={
          <PillButtonUI
            tone="white"
            size="sm"
            onClick={() => router.push(organizationSettingsHref(orgId))}
          >
            Back to General
          </PillButtonUI>
        }
      />
    );

  const deleteData = async (kind: OrgDataKind) => {
    setDeletingKind(kind);
    try {
      if (await needsMfaVerification()) {
        setPendingKind(null);
        setMfaKind(kind);
        return;
      }
      await deleteOrgData(orgId, kind);
      if (kind === "chats" || kind === "projects") {
        // The chat this tab had open may be one of those just deleted.
        setCurrentChatId(null);
        await loadChats();
      }
      setPendingKind(null);
    } catch (error) {
      setPendingKind(null);
      if (isMfaRequiredError(error)) {
        setMfaKind(kind);
        return;
      }
      setWarningMessage("Failed to delete data. Please try again.");
    } finally {
      setDeletingKind(null);
    }
  };

  const pendingRow = DELETE_ROWS.find((row) => row.kind === pendingKind);

  return (
    <div className="space-y-8">
      {org && isOrgOwner(org.role) ? <MemberDataPolicySection /> : null}
      {/* The archive itself is a table of people and their work, so it
          lives with the roster; this is the way to it from here. */}
      {org && isOrgOwner(org.role) ? (
        <section aria-labelledby="org-privacy-departed" className="space-y-3">
          <SettingsHeading id="org-privacy-departed">
            Departed members
          </SettingsHeading>
          <GlassCardUI>
            <SettingsRow>
              <div className="space-y-1">
                <SettingsLabel>Work left by departed members</SettingsLabel>
                <SettingsDescription>
                  Private, unshared work a member leaves behind is kept for 30
                  days, then permanently deleted. Reassign or delete it from
                  the Members page.
                </SettingsDescription>
              </div>
              <PillButtonUI
                tone="black"
                size="sm"
                aria-label="Review departed members"
                onClick={() =>
                  router.push(
                    `${organizationSettingsHref(orgId, "members")}?view=departed`,
                  )
                }
                className="w-full shrink-0 sm:w-auto"
              >
                Review
              </PillButtonUI>
            </SettingsRow>
          </GlassCardUI>
        </section>
      ) : null}
      <section aria-labelledby="org-privacy-delete" className="space-y-3">
        <SettingsHeading id="org-privacy-delete">Delete data</SettingsHeading>
        <GlassCardUI>
          {DELETE_ROWS.map((row) => (
            <SettingsRow key={row.kind}>
              <div className="space-y-1">
                <SettingsLabel>{row.label}</SettingsLabel>
                <SettingsDescription>{row.description}</SettingsDescription>
              </div>
              <PillButtonUI
                tone="danger"
                size="sm"
                aria-label={row.label}
                onClick={() => setPendingKind(row.kind)}
                // Not offered until the caller is known to be an owner.
                disabled={!org || deletingKind !== null}
                loading={deletingKind === row.kind}
                className="w-full shrink-0 sm:w-auto"
              >
                <Trash2 className="h-4 w-4 shrink-0" />
                Delete
              </PillButtonUI>
            </SettingsRow>
          ))}
        </GlassCardUI>
      </section>
      <ConfirmPopup
        open={pendingKind !== null}
        title={pendingRow?.title}
        message={pendingRow?.message}
        confirmLabel="Delete"
        confirmVariant="danger"
        confirmStatus={deletingKind ? "loading" : "idle"}
        cancelLabel="Cancel"
        onCancel={() => {
          if (deletingKind) return;
          setPendingKind(null);
        }}
        onConfirm={() => {
          if (!pendingKind) return;
          void deleteData(pendingKind);
        }}
      />
      <MfaVerificationPopup
        open={mfaKind !== null}
        onCancel={() => setMfaKind(null)}
        onVerified={() => {
          const kind = mfaKind;
          setMfaKind(null);
          if (kind) void deleteData(kind);
        }}
        title="Two-factor verification required"
        message="This action is sensitive. Enter a code from your authenticator app to continue."
      />
      <WarningPopup
        open={!!warningMessage}
        title="Action failed"
        message={warningMessage}
        onClose={() => setWarningMessage(null)}
      />
    </div>
  );
}

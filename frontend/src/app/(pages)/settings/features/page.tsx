"use client";

import { useState, type ReactNode } from "react";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI, PillButtonUI, ToggleSwitchUI } from "@mike/ui";
import { ManagedByOrganization } from "@/app/components/settings/ManagedByOrganization";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  OrganizationWebSearchSection,
  WebSearchSection,
} from "@/app/components/settings/WebSearchSection";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useOrgPreferencesSettings } from "@/app/hooks/useOrgPreferencesSettings";
import { useWorkspaceSettingsScope } from "@/app/hooks/useWorkspaceSettingsScope";
import { notifyError } from "@/app/lib/userFacingError";

/**
 * Settings > Features, for the active workspace: the caller's own in
 * Personal; in an organization's workspace, the organization's, which its
 * owners and admins set for everyone working there.
 */
export default function FeaturesPage() {
  const scope = useWorkspaceSettingsScope();
  if (scope.kind === "loading") return null;
  if (scope.kind === "managed")
    return <ManagedByOrganization subject="Features" orgName={scope.orgName} />;
  if (scope.kind === "organization")
    return <OrganizationFeatures key={scope.orgId} orgId={scope.orgId} />;
  return <PersonalFeatures />;
}

function PersonalFeatures() {
  const {
    profile,
    updateQuickActionsVisible,
    updateResponseDetailsVisible,
  } = useUserProfile();

  return (
    <FeaturesView
      quickActionsVisible={profile?.quickActionsVisible ?? true}
      responseDetailsVisible={profile?.responseDetailsVisible ?? false}
      // A failure is reported by the profile context's notice (with Retry);
      // the toggle reads the profile, so it is already back where it was.
      onQuickActionsVisible={async (visible) => {
        await updateQuickActionsVisible(visible);
      }}
      onResponseDetailsVisible={async (visible) => {
        await updateResponseDetailsVisible(visible);
      }}
      webSearch={<WebSearchSection />}
    />
  );
}

function OrganizationFeatures({ orgId }: { orgId: string }) {
  const { preferences, loadError, retry, save } =
    useOrgPreferencesSettings(orgId);

  const saveToggle = async (
    field: "quick_actions_visible" | "response_details_visible",
    visible: boolean,
    action: string,
  ) => {
    try {
      await save({ [field]: visible });
    } catch (error) {
      // The toggle reads the saved preferences, so it stays where it was.
      notifyError(error, {
        action,
        onRetry: () => void saveToggle(field, visible, action),
      });
    }
  };

  if (loadError)
    return (
      <GlassCardUI>
        <SettingsRow>
          <p className="text-sm text-red-600" role="alert">
            Could not load the organization&apos;s features.
          </p>
          <PillButtonUI tone="white" size="sm" onClick={retry}>
            Retry
          </PillButtonUI>
        </SettingsRow>
      </GlassCardUI>
    );

  return (
    <FeaturesView
      quickActionsVisible={preferences?.quick_actions_visible}
      responseDetailsVisible={preferences?.response_details_visible}
      onQuickActionsVisible={(visible) =>
        saveToggle(
          "quick_actions_visible",
          visible,
          visible ? "show quick actions" : "hide quick actions",
        )
      }
      onResponseDetailsVisible={(visible) =>
        saveToggle(
          "response_details_visible",
          visible,
          visible ? "show response details" : "hide response details",
        )
      }
      webSearch={<OrganizationWebSearchSection orgId={orgId} save={save} />}
    />
  );
}

/** The page itself; a value is `undefined` until it has loaded. */
function FeaturesView({
  quickActionsVisible,
  responseDetailsVisible,
  onQuickActionsVisible,
  onResponseDetailsVisible,
  webSearch,
}: {
  quickActionsVisible: boolean | undefined;
  responseDetailsVisible: boolean | undefined;
  onQuickActionsVisible: (visible: boolean) => Promise<void>;
  onResponseDetailsVisible: (visible: boolean) => Promise<void>;
  webSearch: ReactNode;
}) {
  const [savingQuickActions, setSavingQuickActions] = useState(false);
  const [savingResponseDetails, setSavingResponseDetails] = useState(false);

  const setQuickActionsVisible = async (visible: boolean) => {
    setSavingQuickActions(true);
    await onQuickActionsVisible(visible);
    setSavingQuickActions(false);
  };

  const setResponseDetailsVisible = async (visible: boolean) => {
    setSavingResponseDetails(true);
    await onResponseDetailsVisible(visible);
    setSavingResponseDetails(false);
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading id="assistant-features">Assistant</SettingsHeading>
        <GlassCardUI>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Quick actions</SettingsLabel>
              <SettingsDescription>
                Show the quick actions row on the assistant start screen.
              </SettingsDescription>
            </div>
            <FeatureToggle
              checked={quickActionsVisible}
              saving={savingQuickActions}
              label="Quick actions"
              onCheckedChange={(checked) => void setQuickActionsVisible(checked)}
            />
          </SettingsRow>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Response details</SettingsLabel>
              <SettingsDescription>
                Show the model, reasoning effort and token count under each
                response and subagent.
              </SettingsDescription>
            </div>
            <FeatureToggle
              checked={responseDetailsVisible}
              saving={savingResponseDetails}
              label="Response details"
              onCheckedChange={(checked) =>
                void setResponseDetailsVisible(checked)
              }
            />
          </SettingsRow>
        </GlassCardUI>
      </section>

      {webSearch}
    </div>
  );
}

function FeatureToggle({
  checked,
  saving,
  label,
  onCheckedChange,
}: {
  checked: boolean | undefined;
  saving: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  // The same footprint as the switch, until there is a value to show.
  if (checked === undefined)
    return (
      <div
        className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-app-surface"
        aria-hidden="true"
      />
    );
  return (
    <ToggleSwitchUI
      checked={checked}
      disabled={saving}
      aria-busy={saving}
      aria-label={label}
      onCheckedChange={onCheckedChange}
    />
  );
}

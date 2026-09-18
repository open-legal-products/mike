"use client";

import { useState } from "react";
import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export default function FeaturesPage() {
  const {
    profile,
    updateApiKey,
    updateLegalResearchUs,
    updateQuickActionsVisible,
  } = useUserProfile();
  const [quickActionsError, setQuickActionsError] = useState<string | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [savingQuickActions, setSavingQuickActions] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [optimisticLegalResearchUs, setOptimisticLegalResearchUs] = useState<
    boolean | null
  >(null);

  const persistedLegalResearchUs = profile?.legalResearchUs ?? true;
  const courtListenerEnabled =
    optimisticLegalResearchUs ?? persistedLegalResearchUs;
  const quickActionsVisible = profile?.quickActionsVisible ?? true;

  const setQuickActionsVisible = async (visible: boolean) => {
    setQuickActionsError(null);
    setSavingQuickActions(true);
    const ok = await updateQuickActionsVisible(visible);
    setSavingQuickActions(false);
    if (!ok) setQuickActionsError("Could not update. Try again.");
  };

  const handleCourtListenerChange = async (enabled: boolean) => {
    if (saving) return;
    setSaveError(null);
    setOptimisticLegalResearchUs(enabled);
    setSaving(true);
    const ok = await updateLegalResearchUs(enabled);
    setSaving(false);
    setOptimisticLegalResearchUs(null);
    if (!ok) {
      setSaveError("Could not update. Try again.");
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>Assistant</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Quick actions</SettingsLabel>
              <SettingsDescription>
                Show the quick actions row on the assistant start screen.
              </SettingsDescription>
              {quickActionsError && (
                <p className="text-sm text-red-600" role="alert">
                  {quickActionsError}
                </p>
              )}
            </div>
            <ToggleSwitchUI
              checked={quickActionsVisible}
              disabled={savingQuickActions}
              aria-busy={savingQuickActions}
              aria-label="Quick actions"
              onCheckedChange={(checked) => {
                void setQuickActionsVisible(checked);
              }}
            />
          </SettingsRow>
        </SettingsCard>
      </section>

      <section className="space-y-3">
        <SettingsHeading>Legal Research</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Enable CourtListener</SettingsLabel>
              <SettingsDescription>
                CourtListener provides access to US case law.
              </SettingsDescription>
              {saveError && (
                <p className="text-sm text-red-600" role="alert">
                  {saveError}
                </p>
              )}
            </div>
            <ToggleSwitchUI
              checked={courtListenerEnabled}
              disabled={saving}
              aria-busy={saving}
              aria-label="Enable CourtListener"
              onCheckedChange={(enabled) =>
                void handleCourtListenerChange(enabled)
              }
            />
          </SettingsRow>
          {courtListenerEnabled && (
            <ApiKeyField
              label="CourtListener API Key"
              placeholder="Token..."
              hasSavedKey={profile?.apiKeys.courtlistener.source === "user"}
              onSave={(value) =>
                updateApiKey("courtlistener", value.trim() || null)
              }
              onRemove={() => updateApiKey("courtlistener", null)}
            />
          )}
        </SettingsCard>
      </section>
    </div>
  );
}

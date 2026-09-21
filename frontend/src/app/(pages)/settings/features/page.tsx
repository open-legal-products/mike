"use client";

import { useState } from "react";
import Link from "next/link";
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
    apiKeysDegraded,
    reloadProfile,
    updateApiKey,
    updateLegalResearchUs,
    updateUsptoConnectorEnabled,
    updateQuickActionsVisible,
  } = useUserProfile();
  const [quickActionsError, setQuickActionsError] = useState<string | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [savingUspto, setSavingUspto] = useState(false);
  const [savingQuickActions, setSavingQuickActions] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [usptoSaveError, setUsptoSaveError] = useState<string | null>(null);
  const [optimisticLegalResearchUs, setOptimisticLegalResearchUs] = useState<
    boolean | null
  >(null);
  const [optimisticUsptoConnectorEnabled, setOptimisticUsptoConnectorEnabled] =
    useState<boolean | null>(null);

  const persistedLegalResearchUs = profile?.legalResearchUs ?? true;
  const courtListenerEnabled =
    optimisticLegalResearchUs ?? persistedLegalResearchUs;
  const usptoConnectorEnabled =
    optimisticUsptoConnectorEnabled ??
    (profile?.usptoConnectorEnabled ?? false);
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

  const handleUsptoChange = async (enabled: boolean) => {
    if (savingUspto) return;
    setUsptoSaveError(null);
    setOptimisticUsptoConnectorEnabled(enabled);
    setSavingUspto(true);
    const ok = await updateUsptoConnectorEnabled(enabled);
    setSavingUspto(false);
    setOptimisticUsptoConnectorEnabled(null);
    if (!ok) {
      setUsptoSaveError("Could not update. Try again.");
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

      <section className="space-y-3">
        <SettingsHeading>Connectors</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>USPTO Patent & Trademark</SettingsLabel>
              <SettingsDescription>
                Search USPTO patent and trademark records through a managed
                local connector.
              </SettingsDescription>
              {apiKeysDegraded && (
                <p className="text-sm text-red-600" role="alert">
                  Could not load settings.{" "}
                  <button
                    type="button"
                    onClick={() => void reloadProfile()}
                    className="font-medium underline"
                  >
                    Retry
                  </button>
                </p>
              )}
              {usptoSaveError && (
                <p className="text-sm text-red-600" role="alert">
                  {usptoSaveError}
                </p>
              )}
            </div>
            <ToggleSwitchUI
              checked={apiKeysDegraded ? false : usptoConnectorEnabled}
              disabled={savingUspto || apiKeysDegraded}
              aria-busy={savingUspto}
              aria-label="USPTO Patent & Trademark"
              onCheckedChange={(enabled) => void handleUsptoChange(enabled)}
            />
          </SettingsRow>
          {!apiKeysDegraded && usptoConnectorEnabled && (
            <div className="px-4 pb-3">
              <Link
                href="/settings/connectors"
                className="text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 hover:underline"
              >
                Set up in Connectors
              </Link>
            </div>
          )}
        </SettingsCard>
      </section>
    </div>
  );
}

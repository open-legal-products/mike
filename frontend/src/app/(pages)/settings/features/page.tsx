"use client";

import { useState } from "react";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { WebSearchSection } from "@/app/components/settings/WebSearchSection";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export default function FeaturesPage() {
  const {
    profile,
    updateQuickActionsVisible,
    updateResponseDetailsVisible,
  } = useUserProfile();
  const [savingQuickActions, setSavingQuickActions] = useState(false);
  const [savingResponseDetails, setSavingResponseDetails] = useState(false);
  const quickActionsVisible = profile?.quickActionsVisible ?? true;
  const responseDetailsVisible = profile?.responseDetailsVisible ?? false;

  const setQuickActionsVisible = async (visible: boolean) => {
    setSavingQuickActions(true);
    // A failure is reported by the profile context's notice (with Retry);
    // the toggle reads the profile, so it is already back where it was.
    await updateQuickActionsVisible(visible);
    setSavingQuickActions(false);
  };

  const setResponseDetailsVisible = async (visible: boolean) => {
    setSavingResponseDetails(true);
    // As with quick actions, the profile context reports a failure and the
    // toggle, which reads the profile, stays where it was.
    await updateResponseDetailsVisible(visible);
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
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Response details</SettingsLabel>
              <SettingsDescription>
                Show the model, reasoning effort and token count under each
                response and subagent.
              </SettingsDescription>
            </div>
            <ToggleSwitchUI
              checked={responseDetailsVisible}
              disabled={savingResponseDetails}
              aria-busy={savingResponseDetails}
              aria-label="Response details"
              onCheckedChange={(checked) => {
                void setResponseDetailsVisible(checked);
              }}
            />
          </SettingsRow>
        </GlassCardUI>
      </section>

      <WebSearchSection />
    </div>
  );
}

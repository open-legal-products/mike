"use client";

import { useState } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";

export default function AppearancePage() {
  const { profile, updateDarkMode } = useUserProfile();
  const [savingDarkMode, setSavingDarkMode] = useState(false);
  const [darkModeError, setDarkModeError] = useState<string | null>(null);

  if (!profile) return null;

  const handleDarkModeToggle = async (enabled: boolean) => {
    if (savingDarkMode) return;
    setSavingDarkMode(true);
    setDarkModeError(null);
    try {
      await updateDarkMode(enabled);
    } catch (toggleError) {
      setDarkModeError(
        userFacingApiError(
          toggleError,
          "Could not update the appearance setting.",
        ),
      );
    } finally {
      setSavingDarkMode(false);
    }
  };

  return (
    <section className="space-y-3">
      <SettingsHeading>Appearance</SettingsHeading>
      <SettingsCard>
        <SettingsRow>
          <div className="min-w-0 space-y-1">
            <SettingsLabel>Dark mode</SettingsLabel>
            <SettingsDescription>
              Use a darker color palette throughout Mike.
            </SettingsDescription>
            {darkModeError && (
              <p role="alert" className="text-xs text-red-600">
                {darkModeError}
              </p>
            )}
          </div>
          <ToggleSwitchUI
            checked={profile.darkMode === true}
            disabled={savingDarkMode}
            aria-busy={savingDarkMode}
            aria-label="Dark mode"
            onCheckedChange={(checked) => void handleDarkModeToggle(checked)}
          />
        </SettingsRow>
      </SettingsCard>
    </section>
  );
}

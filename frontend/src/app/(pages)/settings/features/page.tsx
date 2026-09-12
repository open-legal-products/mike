"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export default function FeaturesPage() {
  const t = useTranslations("configuracoes.recursos");
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
    if (!ok) setQuickActionsError(t("erroAtualizar"));
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
      setSaveError(t("erroAtualizar"));
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>{t("tituloAssistente")}</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>{t("acoesRapidas")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoAcoesRapidas")}
              </SettingsDescription>
              {quickActionsError && (
                <p className="text-sm text-red-600" role="alert">
                  {quickActionsError}
                </p>
              )}
            </div>
            <ToggleSwitch
              checked={quickActionsVisible}
              disabled={savingQuickActions}
              aria-busy={savingQuickActions}
              aria-label={t("acoesRapidas")}
              onCheckedChange={(checked) => {
                void setQuickActionsVisible(checked);
              }}
            />
          </SettingsRow>
        </SettingsCard>
      </section>

      <section className="space-y-3">
        <SettingsHeading>{t("tituloPesquisaJuridica")}</SettingsHeading>
        <SettingsCard>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>{t("ativarCourtlistener")}</SettingsLabel>
              <SettingsDescription>
                {t("descricaoCourtlistener")}
              </SettingsDescription>
              {saveError && (
                <p className="text-sm text-red-600" role="alert">
                  {saveError}
                </p>
              )}
            </div>
            <ToggleSwitch
              checked={courtListenerEnabled}
              disabled={saving}
              aria-busy={saving}
              aria-label={t("ativarCourtlistener")}
              onCheckedChange={(enabled) =>
                void handleCourtListenerChange(enabled)
              }
            />
          </SettingsRow>
          {courtListenerEnabled && (
            <ApiKeyField
              label={t("labelCourtlistener")}
              placeholder="Token..."
              hasSavedKey={!!profile?.apiKeys.courtlistener.configured}
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

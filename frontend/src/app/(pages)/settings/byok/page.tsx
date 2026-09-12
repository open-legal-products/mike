"use client";

import { useTranslations } from "next-intl";
import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import { RouterSettingsSection } from "@/app/components/settings/RouterSettingsSection";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

const MODEL_API_KEY_FIELDS = [
  {
    provider: "claude",
    labelKey: "labelClaude",
    placeholder: "sk-ant-...",
  },
  {
    provider: "gemini",
    labelKey: "labelGemini",
    placeholder: "AI...",
  },
  {
    provider: "openai",
    labelKey: "labelOpenai",
    placeholder: "sk-...",
  },
  {
    provider: "openrouter",
    labelKey: "labelOpenrouter",
    placeholder: "sk-or-...",
  },
  {
    provider: "vercel",
    labelKey: "labelVercel",
    placeholder: "vck_...",
  },
  {
    provider: "opencode-go",
    labelKey: "labelOpencodeGo",
    placeholder: "sk-...",
  },
] as const;

export default function ByokPage() {
  const t = useTranslations("configuracoes.byok");
  const tModelos = useTranslations("pages.modelos");
  const { profile, updateApiKey } = useUserProfile();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>{tModelos("chavesTitulo")}</SettingsHeading>
        <SettingsDescription>
          {t("descricaoChaves")}
        </SettingsDescription>
        <SettingsCard>
          {MODEL_API_KEY_FIELDS.map((field) => (
            <div key={field.provider}>
              <ApiKeyField
                label={t(field.labelKey)}
                placeholder={field.placeholder}
                hasSavedKey={profile?.apiKeys[field.provider].source === "user"}
                onSave={(value) =>
                  updateApiKey(field.provider, value.trim() || null)
                }
                onRemove={() => updateApiKey(field.provider, null)}
              />
            </div>
          ))}
        </SettingsCard>
      </section>

      <RouterSettingsSection />
    </div>
  );
}

"use client";

import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import { RouterSettingsSection } from "@/app/components/settings/RouterSettingsSection";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

const MODEL_API_KEY_FIELDS = [
  {
    provider: "claude",
    label: "Anthropic (Claude) API Key",
    placeholder: "sk-ant-...",
  },
  {
    provider: "gemini",
    label: "Google (Gemini) API Key",
    placeholder: "AI...",
  },
  {
    provider: "openai",
    label: "OpenAI API Key",
    placeholder: "sk-...",
  },
  {
    provider: "mistral",
    label: "Mistral AI API Key",
    placeholder: "Enter your Mistral API key",
  },
  {
    provider: "openrouter",
    label: "OpenRouter API Key",
    placeholder: "sk-or-...",
  },
  {
    provider: "vercel",
    label: "Vercel AI Gateway API Key",
    placeholder: "vck_...",
  },
  {
    provider: "opencode-go",
    label: "OpenCode Go API Key",
    placeholder: "sk-...",
  },
] as const;

export default function ByokPage() {
  const { profile, updateApiKey } = useUserProfile();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>API Keys</SettingsHeading>
        <SettingsDescription>
          A personal API key saved here means all future requests for the
          relevant provider will automatically be routed through your API key
          and charged to your own API platform account.
        </SettingsDescription>
        <GlassCardUI>
          {MODEL_API_KEY_FIELDS.map((field) => (
            <div key={field.provider}>
              <ApiKeyField
                label={field.label}
                placeholder={field.placeholder}
                hasSavedKey={profile?.apiKeys[field.provider].source === "user"}
                onSave={(value) =>
                  updateApiKey(field.provider, value.trim() || null)
                }
                onRemove={() => updateApiKey(field.provider, null)}
              />
            </div>
          ))}
        </GlassCardUI>
      </section>

      <RouterSettingsSection />
    </div>
  );
}

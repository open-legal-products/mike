"use client";

import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import { RouterSettingsSection } from "@/app/components/settings/RouterSettingsSection";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { SettingsSection } from "../SettingsSection";

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
        provider: "openrouter",
        label: "OpenRouter API Key",
        placeholder: "sk-or-...",
    },
    {
        provider: "orcarouter",
        label: "OrcaRouter API Key",
        placeholder: "sk-orca-...",
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
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    API Keys
                </h2>
                <p className="text-sm text-gray-500">
                    A personal API key saved here means all future requests for
                    the relevant provider will automatically be routed through
                    your API key and charged to your own API platform account.
                </p>
                <SettingsSection>
                    {MODEL_API_KEY_FIELDS.map((field) => (
                        <div key={field.provider}>
                            <ApiKeyField
                                label={field.label}
                                placeholder={field.placeholder}
                                hasSavedKey={
                                    profile?.apiKeys[field.provider].source ===
                                    "user"
                                }
                                onSave={(value) =>
                                    updateApiKey(
                                        field.provider,
                                        value.trim() || null,
                                    )
                                }
                                onRemove={() =>
                                    updateApiKey(field.provider, null)
                                }
                            />
                        </div>
                    ))}
                </SettingsSection>
            </section>

            <RouterSettingsSection />
        </div>
    );
}

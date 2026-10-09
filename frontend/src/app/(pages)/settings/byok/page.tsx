"use client";

import { useState } from "react";
import Image from "next/image";
import { Plug, type LucideIcon } from "lucide-react";

import { ByokProviderModal } from "@/app/components/settings/ByokProviderModal";
import { ConnectorCard } from "@/app/components/settings/ConnectorCard";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { isMfaRequiredError, type ApiKeyProvider } from "@/app/lib/mikeApi";
type ModelApiKeyField = {
    provider: ApiKeyProvider;
    name: string;
    /** A vendored provider logo, or a Lucide icon where there is no brand. */
    logo?: string;
    icon?: LucideIcon;
    label: string;
    keyLabel?: string;
};

const MODEL_API_KEY_FIELDS: readonly ModelApiKeyField[] = [
    {
        provider: "claude",
        name: "Anthropic (Claude)",
        logo: "anthropic",
        label: "Anthropic (Claude) API Key",
    },
    {
        provider: "gemini",
        name: "Google (Gemini)",
        logo: "gemini-color",
        label: "Google (Gemini) API Key",
    },
    {
        provider: "openai",
        name: "OpenAI",
        logo: "openai",
        label: "OpenAI API Key",
    },
    {
        provider: "mistral",
        name: "Mistral AI",
        logo: "mistral-color",
        label: "Mistral AI API Key",
    },
    {
        provider: "xai",
        name: "xAI",
        logo: "xai",
        label: "xAI API Key",
    },
    {
        provider: "bedrock",
        name: "Amazon Bedrock",
        logo: "bedrock-color",
        label: "Amazon Bedrock API Key",
    },
    {
        provider: "azure",
        name: "Azure OpenAI",
        logo: "azure-color",
        label: "Azure OpenAI API Key",
    },
    {
        provider: "azure-foundry",
        name: "Azure AI Foundry",
        logo: "azureai-color",
        label: "Azure AI Foundry API Key",
    },
    {
        provider: "vertex",
        name: "Google Vertex AI",
        logo: "vertexai-color",
        label: "Google Vertex AI service-account key",
        keyLabel: "Service-account key (JSON)",
    },
    {
        provider: "openrouter",
        name: "OpenRouter",
        logo: "openrouter-color",
        label: "OpenRouter API Key",
    },
    {
        provider: "vercel",
        name: "Vercel AI Gateway",
        logo: "vercel",
        label: "Vercel AI Gateway API Key",
    },
    {
        provider: "opencode-go",
        name: "OpenCode Go",
        logo: "opencode",
        label: "OpenCode Go API Key",
    },
    {
        provider: "custom",
        name: "OpenAI-compatible endpoint",
        icon: Plug,
        label: "OpenAI-compatible endpoint API Key",
    },
];

/**
 * A provider is listed as saved once the user has saved their own key for it. It
 * stays there while switched off, so the switch does not move under the
 * pointer and the provider can be switched back on.
 */
const PROVIDER_SECTIONS = [
    {
        id: "active",
        active: true,
        title: "Saved Providers",
        empty: "No saved providers yet. Add an API key to one of the providers below.",
    },
    {
        id: "available",
        active: false,
        title: "Available Providers",
        empty: "Every provider has a key saved.",
    },
] as const;

export default function ByokPage() {
    const { profile, loading, updateApiKeyEnabled } = useUserProfile();
    const [busyProvider, setBusyProvider] = useState<ApiKeyProvider | null>(null);
    const [toggleError, setToggleError] = useState<string | null>(null);
    const [pendingToggle, setPendingToggle] = useState<{ provider: ApiKeyProvider; enabled: boolean } | null>(null);
    const [selectedProvider, setSelectedProvider] = useState<string | null>(
        null,
    );
    const selected = MODEL_API_KEY_FIELDS.find(
        (field) => field.provider === selectedProvider,
    );

    async function toggleProvider(provider: ApiKeyProvider, enabled: boolean) {
        setBusyProvider(provider);
        setToggleError(null);
        try {
            const saved = await updateApiKeyEnabled(provider, enabled);
            if (!saved) setToggleError("The provider could not be updated. Please try again.");
        } catch (error) {
            if (isMfaRequiredError(error)) setPendingToggle({ provider, enabled });
            else setToggleError("The provider could not be updated. Please try again.");
        } finally {
            setBusyProvider(null);
        }
    }

    const renderToggle = (field: ModelApiKeyField, label: string) => (
        <ToggleSwitchUI
            checked={profile?.apiKeys[field.provider]?.enabled !== false}
            disabled={busyProvider !== null || pendingToggle !== null}
            aria-busy={busyProvider === field.provider}
            aria-label={label}
            onCheckedChange={(enabled) =>
                void toggleProvider(field.provider, enabled)
            }
        />
    );

    const renderCard = (field: ModelApiKeyField) => {
        const hasSavedKey =
            profile?.apiKeys[field.provider]?.source === "user";
        const Icon = field.icon;
        const blocked = loading || busyProvider === field.provider;
        const open = () => {
            if (!blocked) setSelectedProvider(field.provider);
        };
        return (
            <ConnectorCard
                key={field.provider}
                kind="provider"
                name={field.name}
                icon={
                    loading ? (
                        <span className="h-7 w-7 animate-pulse rounded-lg bg-gray-200" />
                    ) : Icon ? (
                        <Icon
                            aria-hidden="true"
                            className="h-6 w-6 text-gray-500"
                        />
                    ) : (
                        <Image
                            src={`/icons/providers/${field.logo}.svg`}
                            alt=""
                            width={28}
                            height={28}
                            className={
                                field.logo?.endsWith("-color")
                                    ? ""
                                    : "dark:invert"
                            }
                        />
                    )
                }
                // Like connectors: a saved provider opens from anywhere on
                // its card, an available one only from its Add button.
                onOpen={hasSavedKey ? open : undefined}
                action={
                    hasSavedKey ? (
                        renderToggle(field, `${field.name} provider`)
                    ) : (
                        <PillButtonUI
                            tone="blue"
                            size="sm"
                            disabled={blocked}
                            aria-label={`Add ${field.name}`}
                            aria-haspopup="dialog"
                            onClick={open}
                        >
                            Add
                        </PillButtonUI>
                    )
                }
            />
        );
    };

    return (
        <div className="@container space-y-8">
            {PROVIDER_SECTIONS.map((section) => {
                // While the profile loads, which providers are active is not
                // known yet: every card waits in the second section.
                const fields = MODEL_API_KEY_FIELDS.filter(
                    (field) =>
                        (!loading &&
                            profile?.apiKeys[field.provider]?.source ===
                                "user") === section.active,
                );
                const headingId = `byok-${section.id}-providers`;
                return (
                    <section
                        key={section.id}
                        aria-labelledby={headingId}
                        className="space-y-3"
                    >
                        <SettingsHeading id={headingId}>
                            {section.title}
                        </SettingsHeading>
                        {loading && section.active ? (
                            <span className="block h-5 w-56 max-w-full animate-pulse rounded bg-gray-200" />
                        ) : fields.length === 0 ? (
                            <SettingsDescription>
                                {section.empty}
                            </SettingsDescription>
                        ) : (
                            <div
                                className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2"
                                aria-busy={loading}
                            >
                                {fields.map(renderCard)}
                            </div>
                        )}
                    </section>
                );
            })}
            <ByokProviderModal
                provider={selected ?? null}
                enabledToggle={
                    selected &&
                    profile?.apiKeys[selected.provider]?.source === "user"
                        ? renderToggle(selected, `Use ${selected.name}`)
                        : undefined
                }
                onClose={() => setSelectedProvider(null)}
            />
            <MfaVerificationPopup
                open={pendingToggle !== null}
                onCancel={() => setPendingToggle(null)}
                onVerified={() => {
                    if (!pendingToggle) return;
                    const action = pendingToggle;
                    setPendingToggle(null);
                    void toggleProvider(action.provider, action.enabled);
                }}
            />
            <WarningPopup
                open={toggleError !== null}
                title="Provider update failed"
                message={toggleError}
                onClose={() => setToggleError(null)}
            />
        </div>
    );
}

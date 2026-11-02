import Image from "next/image";
import { Plug, type LucideIcon } from "lucide-react";
import type { ApiKeyProvider } from "@/app/lib/mikeApi";

// The model providers a key can be saved for, in the order they are listed.
// Shared by a person's Bring Your Own Keys page and an organization's Model
// Providers tab, so the two always offer the same providers under the same
// names.

export type ModelApiKeyField = {
    provider: ApiKeyProvider;
    name: string;
    /** A vendored provider logo, or a Lucide icon where there is no brand. */
    logo?: string;
    icon?: LucideIcon;
    label: string;
    keyLabel?: string;
};

export const MODEL_API_KEY_FIELDS: readonly ModelApiKeyField[] = [
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

/** A provider's logo, or a pulsing stand-in while its state is loading. */
export function ModelProviderIcon({
    field,
    loading = false,
}: {
    field: ModelApiKeyField;
    loading?: boolean;
}) {
    if (loading)
        return <span className="h-7 w-7 animate-pulse rounded-lg bg-gray-200" />;
    const Icon = field.icon;
    if (Icon)
        return <Icon aria-hidden="true" className="h-6 w-6 text-gray-500" />;
    return (
        <Image
            src={`/icons/providers/${field.logo}.svg`}
            alt=""
            width={28}
            height={28}
            className={field.logo?.endsWith("-color") ? "" : "dark:invert"}
        />
    );
}

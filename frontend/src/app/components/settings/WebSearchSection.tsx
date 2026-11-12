"use client";

import { useEffect, useRef, useState } from "react";
import { ApiKeyField } from "@/app/components/settings/ApiKeyField";
import { GlassCardUI, PillButtonUI, ToggleSwitchUI } from "@mike/ui";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsSelectRow,
  type SettingsSelectOption,
} from "@/app/components/settings/SettingsSelectRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useAssignLatest } from "@/app/hooks/useLatestRef";
import { isProviderAvailable } from "@/app/lib/modelAvailability";
import {
  getWebSearchSettings,
  updateWebSearchSettings,
  WEB_SEARCH_BACKENDS,
  type WebSearchBackend,
  type WebSearchSettings,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";

const SEARCH_SERVICES: Record<
  WebSearchBackend,
  { label: string; description: string; keyLabel: string }
> = {
  brave: {
    label: "Brave Search",
    description: "Mike searches with Brave Search. Works with any model.",
    keyLabel: "Brave Search API Key",
  },
  tavily: {
    label: "Tavily",
    description: "Tavily searches and reads pages. Works with any model.",
    keyLabel: "Tavily API Key",
  },
  deepseek: {
    label: "DeepSeek Search",
    description: "DeepSeek searches and reads pages. Works with any model.",
    keyLabel: "DeepSeek API Key",
  },
};

const SEARCH_SERVICE_OPTIONS: SettingsSelectOption[] = WEB_SEARCH_BACKENDS.map(
  (backend) => {
    const { label, description } = SEARCH_SERVICES[backend];
    return { value: backend, label, description };
  },
);

type Field = keyof WebSearchSettings;

type Family = Exclude<Field, "enabled">;

const PROVIDER_FAMILIES: Array<{
  family: "claude" | "openai";
  label: string;
  provider: { label: string; description: string };
}> = [
  {
    family: "claude",
    label: "Claude models",
    provider: {
      label: "Anthropic Search",
      description: "Anthropic runs the search. Billed to your Claude API key.",
    },
  },
  {
    family: "openai",
    label: "OpenAI models",
    provider: {
      label: "OpenAI Search",
      description: "OpenAI runs the search. Billed to your OpenAI API key.",
    },
  },
];

const OFF_OPTION = {
  value: "off",
  label: "Off",
  description: "These models won't search the web.",
};

function saveAction(field: Field, next: WebSearchSettings[Field]): string {
  if (field === "enabled") {
    return next ? "turn on web search" : "turn off web search";
  }
  const family = PROVIDER_FAMILIES.find((entry) => entry.family === field);
  return `change web search for ${family?.label ?? "other models"}`;
}

export function WebSearchSection() {
  const { profile, updateApiKey } = useUserProfile();
  const [settings, setSettings] = useState<WebSearchSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  // Per setting, only the newest choice may settle the UI; an older save
  // that resolves late must not overwrite it.
  const latestRequestRef = useRef<Record<Field, number>>({
    enabled: 0,
    claude: 0,
    openai: 0,
    other: 0,
  });
  const retryRef = useRef<
    ((field: Field, next: WebSearchSettings[Field]) => Promise<void>) | null
  >(null);

  useEffect(() => {
    const controller = new AbortController();
    getWebSearchSettings(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setSettings(loaded);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
  }, [loadVersion]);

  const save = async <F extends Field>(field: F, next: WebSearchSettings[F]) => {
    if (!settings || settings[field] === next) return;
    const previous = settings[field];
    const request = ++latestRequestRef.current[field];
    const settle = (value: WebSearchSettings[F]) =>
      setSettings((current) =>
        current ? { ...current, [field]: value } : current,
      );
    settle(next);
    try {
      const saved = await updateWebSearchSettings({ [field]: next });
      if (request !== latestRequestRef.current[field]) return;
      settle(saved[field]);
    } catch (error) {
      if (request !== latestRequestRef.current[field]) return;
      settle(previous);
      notifyError(error, {
        action: saveAction(field, next),
        onRetry: () => void retryRef.current?.(field, next),
      });
    }
  };
  useAssignLatest(retryRef, save);

  const toggleWebSearch = async (enabled: boolean) => {
    setSaving(true);
    await save("enabled", enabled);
    setSaving(false);
  };

  const providerFamilies = PROVIDER_FAMILIES.filter(
    ({ family }) => profile && isProviderAvailable(family, profile.apiKeys),
  ).map(({ family, label, provider }) => ({
    family,
    label,
    options: [
      { value: "provider", ...provider },
      ...SEARCH_SERVICE_OPTIONS,
      OFF_OPTION,
    ],
  }));
  const families: Array<{
    family: Family;
    label: string;
    options: SettingsSelectOption[];
  }> = [
    ...providerFamilies,
    {
      family: "other",
      label: providerFamilies.length > 0 ? "Other models" : "All models",
      options: [...SEARCH_SERVICE_OPTIONS, OFF_OPTION],
    },
  ];
  const chosenServices =
    settings?.enabled && profile
      ? WEB_SEARCH_BACKENDS.filter((backend) =>
          families.some(({ family }) => settings[family] === backend),
        )
      : [];

  return (
    <section className="space-y-3" aria-labelledby="web-search-heading">
      <SettingsHeading id="web-search-heading">Web Search</SettingsHeading>
      <GlassCardUI>
        {loadError ? (
          <SettingsRow>
            <p className="text-sm text-red-600" role="alert">
              Could not load your web search settings.
            </p>
            <PillButtonUI
              tone="white"
              size="sm"
              onClick={() => {
                setLoadError(false);
                setLoadVersion((current) => current + 1);
              }}
            >
              Retry
            </PillButtonUI>
          </SettingsRow>
        ) : (
          <>
            <SettingsRow>
              <div className="min-w-0 space-y-1">
                <SettingsLabel>Enable web search</SettingsLabel>
                <SettingsDescription>
                  Let Mike search the web and read pages when an answer needs
                  current or public information.
                </SettingsDescription>
              </div>
              {settings ? (
                <ToggleSwitchUI
                  checked={settings.enabled}
                  disabled={saving}
                  aria-busy={saving}
                  aria-label="Enable web search"
                  onCheckedChange={(enabled) => void toggleWebSearch(enabled)}
                />
              ) : (
                <div
                  className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-app-surface"
                  aria-hidden="true"
                />
              )}
            </SettingsRow>
            {settings?.enabled &&
              profile &&
              families.map(({ family, label, options }) => (
                <SettingsSelectRow
                  key={family}
                  id={`web-search-${family}`}
                  label={label}
                  options={options}
                  value={settings[family]}
                  onChange={(next) =>
                    void save(family, next as WebSearchSettings[Family])
                  }
                />
              ))}
            {chosenServices.map((service) => (
              <ApiKeyField
                key={service}
                label={SEARCH_SERVICES[service].keyLabel}
                hasSavedKey={profile?.apiKeys[service].source === "user"}
                onSave={(value) => updateApiKey(service, value.trim() || null)}
                onRemove={() => updateApiKey(service, null)}
              />
            ))}
          </>
        )}
      </GlassCardUI>
    </section>
  );
}

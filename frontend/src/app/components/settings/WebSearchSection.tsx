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
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { useAssignLatest } from "@/app/hooks/useLatestRef";
import { useModelApiKeys } from "@/app/hooks/useModelApiKeys";
import { isProviderAvailable } from "@/app/lib/modelAvailability";
import {
  getOrgPreferences,
  getWebSearchSettings,
  saveOrgApiKey,
  updateWebSearchSettings,
  WEB_SEARCH_BACKENDS,
  type ApiKeyState,
  type OrgPreferences,
  type OrgPreferencesUpdate,
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
  provider: { label: string; runs: string; key: string };
}> = [
  {
    family: "claude",
    label: "Claude models",
    provider: { label: "Anthropic Search", runs: "Anthropic", key: "Claude" },
  },
  {
    family: "openai",
    label: "OpenAI models",
    provider: { label: "OpenAI Search", runs: "OpenAI", key: "OpenAI" },
  },
];

/**
 * Where the section's settings and search-service keys live: the caller's
 * own in Personal, the organization's in its workspace.
 */
export interface WebSearchStore {
  load: (signal: AbortSignal) => Promise<WebSearchSettings>;
  save: (update: Partial<WebSearchSettings>) => Promise<WebSearchSettings>;
  /** The keys that decide which model families can search; unknown while loading. */
  apiKeys: ApiKeyState | undefined;
  hasSavedKey: (service: WebSearchBackend) => boolean;
  saveKey: (service: WebSearchBackend, value: string | null) => Promise<boolean>;
  /** Whose keys a search is billed to, and whose settings these are. */
  owner: "your" | "the organization's";
}

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

/** The caller's own web search settings, for the Personal workspace. */
export function WebSearchSection() {
  const { profile, updateApiKey } = useUserProfile();
  const store: WebSearchStore = {
    load: getWebSearchSettings,
    save: updateWebSearchSettings,
    apiKeys: profile?.apiKeys,
    hasSavedKey: (service) => profile?.apiKeys[service].source === "user",
    saveKey: (service, value) => updateApiKey(service, value),
    owner: "your",
  };
  return <WebSearchCard store={store} />;
}

/**
 * An organization's web search settings, which govern work in its workspace:
 * its owners and admins choose them, and searches run on its keys.
 */
export function OrganizationWebSearchSection({
  orgId,
  save,
}: {
  orgId: string;
  /** Saves the organization's preferences and puts the answer in place. */
  save: (update: OrgPreferencesUpdate) => Promise<OrgPreferences>;
}) {
  const { orgApiKeys, refreshOrgApiKeys } = useWorkspace();
  const apiKeys = useModelApiKeys();
  const store: WebSearchStore = {
    load: (signal) =>
      getOrgPreferences(orgId, signal).then((loaded) => loaded.web_search),
    save: (update) =>
      save({ web_search: update }).then((saved) => saved.web_search),
    apiKeys,
    // Saved by the organization itself: a deployment-wide key also reads as
    // configured, but there is no organization key to show or remove.
    hasSavedKey: (service) => orgApiKeys?.keys.sources?.[service] === "org",
    saveKey: async (service, value) => {
      await saveOrgApiKey(orgId, service, value);
      await refreshOrgApiKeys();
      return true;
    },
    owner: "the organization's",
  };
  return <WebSearchCard key={orgId} store={store} />;
}

function WebSearchCard({ store }: { store: WebSearchStore }) {
  const { apiKeys } = store;
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
    store
      .load(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setSettings(loaded);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadError(true);
      });
    return () => controller.abort();
    // Loaded once per store owner (the caller keys the card by it) and on Retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const saved = await store.save({ [field]: next });
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
    ({ family }) => apiKeys && isProviderAvailable(family, apiKeys),
  ).map(({ family, label, provider }) => ({
    family,
    label,
    options: [
      {
        value: "provider",
        label: provider.label,
        description: `${provider.runs} runs the search. Billed to ${store.owner} ${provider.key} API key.`,
      },
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
    settings?.enabled && apiKeys
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
              Could not load {store.owner} web search settings.
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
              apiKeys &&
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
                owner={store.owner}
                hasSavedKey={store.hasSavedKey(service)}
                onSave={(value) => store.saveKey(service, value.trim() || null)}
                onRemove={() => store.saveKey(service, null)}
              />
            ))}
          </>
        )}
      </GlassCardUI>
    </section>
  );
}

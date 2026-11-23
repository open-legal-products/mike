"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import {
  DROPDOWN_ROWS_CLASS,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
  REASONING_LEVELS,
  REASONING_LEVEL_LABELS,
  orderedModelGroups,
  GlassCardUI,
  PillButtonUI,
} from "@mike/ui";
import {
  useUserProfile,
  type PreferenceField,
} from "@/app/contexts/UserProfileContext";
import { type ApiKeyState, type OrgPreferences } from "@/app/lib/mikeApi";
import { mergeConfiguredModelOptions } from "@/app/components/assistant/ModelToggle";
import {
  MODELS,
  SETTINGS_MODELS,
  allRouterModelOptions,
  canonicalModelId,
  type ModelOption,
} from "@mike/client";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";
import { useConfiguredModels } from "@/app/hooks/useConfiguredModels";
import { useModelApiKeys } from "@/app/hooks/useModelApiKeys";
import { useModelRouterSelections } from "@/app/hooks/useModelRouterSelections";
import { useOrgPreferencesSettings } from "@/app/hooks/useOrgPreferencesSettings";
import { useWorkspaceSettingsScope } from "@/app/hooks/useWorkspaceSettingsScope";
import { ManagedByOrganization } from "@/app/components/settings/ManagedByOrganization";
import { notifyError } from "@/app/lib/userFacingError";

/** A preference's saved value, by field; `null` until they have loaded. */
type PreferenceValues = Record<PreferenceField, string | null>;

/** The organization's column for each field. */
const ORG_COLUMNS = {
  titleModel: "title_model",
  tabularModel: "tabular_model",
  memoryCuratorModel: "memory_curator_model",
  subagentModel: "subagent_model",
  subagentReasoning: "subagent_reasoning",
} as const satisfies Record<PreferenceField, keyof OrgPreferences>;

/** Lower case, for "Couldn't change …". */
const FIELD_LABELS: Record<PreferenceField, string> = {
  titleModel: "the chat title model",
  tabularModel: "the tabular review model",
  memoryCuratorModel: "the memory curation model",
  subagentModel: "the subagent model",
  subagentReasoning: "the subagent reasoning",
};

/**
 * Settings > Model Preferences, for the active workspace: the caller's own
 * in Personal; in an organization's workspace, the organization's, which its
 * owners and admins set for everyone working there.
 */
export default function ModelPreferencesPage() {
  const scope = useWorkspaceSettingsScope();
  if (scope.kind === "loading") return null;
  if (scope.kind === "managed")
    return (
      <ManagedByOrganization
        subject="Model preferences"
        orgName={scope.orgName}
      />
    );
  if (scope.kind === "organization")
    return (
      <OrganizationModelPreferences key={scope.orgId} orgId={scope.orgId} />
    );
  return <PersonalModelPreferences />;
}

function PersonalModelPreferences() {
  const { profile, updateModelPreference } = useUserProfile();
  return (
    <ModelPreferencesView
      values={
        profile
          ? {
              titleModel: profile.titleModel ?? null,
              tabularModel: profile.tabularModel ?? null,
              memoryCuratorModel: profile.memoryCuratorModel ?? null,
              subagentModel: profile.subagentModel ?? null,
              subagentReasoning: profile.subagentReasoning ?? null,
            }
          : null
      }
      // The profile context classifies a failure and raises the notice.
      savePreference={updateModelPreference}
    />
  );
}

function OrganizationModelPreferences({ orgId }: { orgId: string }) {
  const { preferences, loadError, retry, save } =
    useOrgPreferencesSettings(orgId);

  const savePreference = async (
    field: PreferenceField,
    value: string | null,
  ): Promise<boolean> => {
    try {
      await save({ [ORG_COLUMNS[field]]: value });
      return true;
    } catch (error) {
      notifyError(error, {
        action: `change ${FIELD_LABELS[field]}`,
        onRetry: () => void savePreference(field, value),
      });
      return false;
    }
  };

  if (loadError)
    return (
      <GlassCardUI>
        <SettingsRow>
          <p className="text-sm text-red-600" role="alert">
            Could not load the organization&apos;s model preferences.
          </p>
          <PillButtonUI tone="white" size="sm" onClick={retry}>
            Retry
          </PillButtonUI>
        </SettingsRow>
      </GlassCardUI>
    );

  return (
    <ModelPreferencesView
      values={
        preferences
          ? (Object.fromEntries(
              Object.entries(ORG_COLUMNS).map(([field, column]) => [
                field,
                preferences[column] as string | null,
              ]),
            ) as PreferenceValues)
          : null
      }
      savePreference={savePreference}
    />
  );
}

function ModelPreferencesView({
  values,
  savePreference,
}: {
  values: PreferenceValues | null;
  /** Resolves false when the change was refused (and has been reported). */
  savePreference: (field: PreferenceField, value: string | null) => Promise<boolean>;
}) {
  // The keys and model lists that govern the workspace: the caller's own in
  // Personal, the organization's in its workspace.
  const apiKeys = useModelApiKeys();
  const routerLists = useModelRouterSelections();
  const ollamaModels = useOllamaModels();
  const configuredModels = useConfiguredModels();
  const preferenceModelId = (id: string) =>
    configuredModels.some((model) => model.id === id) ? id : canonicalModelId(id);
  const [savingField, setSavingField] = useState<PreferenceField | null>(
    null,
  );
  const [savedField, setSavedField] = useState<PreferenceField | null>(
    null,
  );
  const [optimisticValues, setOptimisticValues] = useState<
    Partial<Record<PreferenceField, string>>
  >({});
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRouterOptions = allRouterModelOptions(routerLists ?? {});

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const handlePreferenceChange = async (field: PreferenceField, id: string) => {
    setOptimisticValues((current) => ({ ...current, [field]: id }));
    setSavedField(null);
    setSavingField(field);
    const ok = await savePreference(field, id || null);
    setSavingField((current) => (current === field ? null : current));
    if (ok) {
      setSavedField(field);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setSavedField((current) => (current === field ? null : current));
      }, 1600);
    } else {
      // `savePreference` has already reported the failure, with a Retry;
      // here the dropdown only snaps back to the saved value, so the page
      // never shows a preference the server did not accept.
      setOptimisticValues((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading id="model-preferences">Model Preferences</SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Chat title generation</SettingsLabel>
              <SettingsDescription>
                By default, titles use a low cost model from the chat
                provider. Choose a model here to override that.
              </SettingsDescription>
            </div>
            <ModelPreferenceDropdown
              value={preferenceModelId(
                optimisticValues.titleModel ?? values?.titleModel ?? "",
              )}
              options={mergeConfiguredModelOptions(configuredModels, [
                ...SETTINGS_MODELS,
                ...selectedRouterOptions,
                ...ollamaModels,
              ])}
              apiKeys={apiKeys}
              isSaving={savingField === "titleModel"}
              isSaved={savedField === "titleModel"}
              emptyOptionLabel="Automatic — same provider as chat"
              onChange={(id) => handlePreferenceChange("titleModel", id)}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Tabular review model</SettingsLabel>
              <SettingsDescription>
                Preselected when creating a review. Each review stores its own
                model and can be changed separately.
              </SettingsDescription>
            </div>
            <ModelPreferenceDropdown
              value={preferenceModelId(
                optimisticValues.tabularModel ?? values?.tabularModel ?? "",
              )}
              options={mergeConfiguredModelOptions(configuredModels, [
                ...MODELS,
                ...selectedRouterOptions,
                ...ollamaModels,
              ])}
              apiKeys={apiKeys}
              isSaving={savingField === "tabularModel"}
              isSaved={savedField === "tabularModel"}
              emptyOptionLabel="No default model"
              onChange={(id) => handlePreferenceChange("tabularModel", id)}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Memory curation model</SettingsLabel>
              <SettingsDescription>
                Used after conversations to identify durable information worth
                keeping. By default, memory uses the model selected for the
                chat.
              </SettingsDescription>
            </div>
            <ModelPreferenceDropdown
              value={preferenceModelId(
                optimisticValues.memoryCuratorModel ??
                  values?.memoryCuratorModel ??
                  "",
              )}
              options={mergeConfiguredModelOptions(configuredModels, [
                ...SETTINGS_MODELS,
                ...selectedRouterOptions,
                ...ollamaModels,
              ])}
              apiKeys={apiKeys}
              isSaving={savingField === "memoryCuratorModel"}
              isSaved={savedField === "memoryCuratorModel"}
              emptyOptionLabel="Automatic — use chat model"
              onChange={(id) =>
                handlePreferenceChange("memoryCuratorModel", id)
              }
            />
          </SettingsRow>
        </GlassCardUI>
      </section>

      <section className="space-y-3" aria-labelledby="subagents-heading">
        <SettingsHeading id="subagents-heading">Subagents</SettingsHeading>
        <SettingsDescription>
          Mike can hand parts of a task to subagents that work on them
          separately and report back. These are the defaults it follows unless
          you ask for something else in the chat.
        </SettingsDescription>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Model</SettingsLabel>
              <SettingsDescription>
                The model each subagent runs on. Chosen per task lets Mike
                match the model to the work.
              </SettingsDescription>
            </div>
            <ModelPreferenceDropdown
              value={preferenceModelId(
                optimisticValues.subagentModel ?? values?.subagentModel ?? "",
              )}
              options={mergeConfiguredModelOptions(configuredModels, [
                ...MODELS,
                ...selectedRouterOptions,
                ...ollamaModels,
              ])}
              apiKeys={apiKeys}
              isSaving={savingField === "subagentModel"}
              isSaved={savedField === "subagentModel"}
              emptyOptionLabel="Chosen per task"
              onChange={(id) => handlePreferenceChange("subagentModel", id)}
            />
          </SettingsRow>
          <SettingsRow layout="stacked">
            <div className="space-y-1">
              <SettingsLabel>Reasoning</SettingsLabel>
              <SettingsDescription>
                How much each subagent thinks before it answers.
              </SettingsDescription>
            </div>
            <ReasoningPreferenceDropdown
              value={
                optimisticValues.subagentReasoning ??
                values?.subagentReasoning ??
                ""
              }
              isSaving={savingField === "subagentReasoning"}
              isSaved={savedField === "subagentReasoning"}
              emptyOptionLabel="Chosen per task"
              onChange={(level) =>
                handlePreferenceChange("subagentReasoning", level)
              }
            />
          </SettingsRow>
        </GlassCardUI>
      </section>
    </div>
  );
}

function ModelPreferenceDropdown({
  value,
  onChange,
  apiKeys,
  options,
  isSaving,
  isSaved,
  emptyOptionLabel,
}: {
  value: string;
  onChange: (id: string) => void;
  apiKeys?: ApiKeyState;
  options: ModelOption[];
  isSaving?: boolean;
  isSaved?: boolean;
  emptyOptionLabel: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const availableOptions = options.filter((model) => {
    if (model.source === "Configured") return true;
    if (model.group === "Local") return true;
    return apiKeys ? isModelAvailable(model.id, apiKeys) : false;
  });
  const selected = availableOptions.find((model) => model.id === value);
  const availableGroups = orderedModelGroups(availableOptions).flatMap(
    (group) => {
      const items = availableOptions.filter((model) => model.group === group);
      return items.length ? [{ group, items }] : [];
    },
  );
  const routeCounts = availableOptions.reduce((counts, model) => {
    const key = `${model.group}\u0000${model.label.toLocaleLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  return (
    <Dropdown onOpenChange={setIsOpen}>
      <PreferenceTrigger
        label={
          !value ? emptyOptionLabel : (selected?.label ?? "Select a model")
        }
        isOpen={isOpen}
        isSaving={isSaving}
        isSaved={isSaved}
      />
      <DropdownContent
        style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
        align="start"
      >
        <DropdownItem
          className="cursor-pointer"
          onSelect={() => onChange("")}
        >
          <span className="flex-1">{emptyOptionLabel}</span>
          {!value && <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />}
        </DropdownItem>
        {availableGroups.length > 0 && <DropdownSeparator />}
        {availableGroups.map(({ group, items }, groupIndex) => {
          return (
            <div key={group} className={DROPDOWN_ROWS_CLASS}>
              {groupIndex > 0 && <DropdownSeparator />}
              <DropdownLabel>
                {group}
              </DropdownLabel>
              {items.map((m) => {
                return (
                  <DropdownItem
                    key={m.id}
                    className="cursor-pointer"
                    onSelect={() => onChange(m.id)}
                  >
                    <span className="flex-1">{m.label}</span>
                    {m.source &&
                      (routeCounts.get(
                        `${m.group}\u0000${m.label.toLocaleLowerCase()}`,
                      ) ?? 0) > 1 && (
                        <span className="text-[9px] font-medium text-gray-400">
                          {m.source}
                        </span>
                      )}
                    {m.id === value && (
                      <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                    )}
                  </DropdownItem>
                );
              })}
            </div>
          );
        })}
      </DropdownContent>
    </Dropdown>
  );
}

function PreferenceTrigger({
  label,
  isOpen,
  isSaving,
  isSaved,
}: {
  label: string;
  isOpen: boolean;
  isSaving?: boolean;
  isSaved?: boolean;
}) {
  return (
    <DropdownTrigger asChild>
      <button
        type="button"
        disabled={isSaving}
        className={`flex h-9 items-center justify-between gap-2 hover:bg-gray-200/70 ${SETTINGS_CONTROL_CLASS}`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate text-gray-900">{label}</span>
        </span>
        {isSaving ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-500" />
        ) : isSaved ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
        ) : (
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          />
        )}
      </button>
    </DropdownTrigger>
  );
}

function ReasoningPreferenceDropdown({
  value,
  onChange,
  isSaving,
  isSaved,
  emptyOptionLabel,
}: {
  value: string;
  onChange: (level: string) => void;
  isSaving?: boolean;
  isSaved?: boolean;
  emptyOptionLabel: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = REASONING_LEVELS.find((level) => level === value);

  return (
    <Dropdown onOpenChange={setIsOpen}>
      <PreferenceTrigger
        label={selected ? REASONING_LEVEL_LABELS[selected] : emptyOptionLabel}
        isOpen={isOpen}
        isSaving={isSaving}
        isSaved={isSaved}
      />
      <DropdownContent
        style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
        align="start"
      >
        <DropdownItem
          className="cursor-pointer"
          onSelect={() => onChange("")}
        >
          <span className="flex-1">{emptyOptionLabel}</span>
          {!selected && <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />}
        </DropdownItem>
        <DropdownSeparator />
        {REASONING_LEVELS.map((level) => (
          <DropdownItem
            key={level}
            className="cursor-pointer"
            onSelect={() => onChange(level)}
          >
            <span className="flex-1">{REASONING_LEVEL_LABELS[level]}</span>
            {level === selected && (
              <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
            )}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}

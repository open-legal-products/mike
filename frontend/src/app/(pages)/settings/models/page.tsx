"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { type ApiKeyState } from "@/app/lib/mikeApi";
import {
    MODELS,
    SETTINGS_MODELS,
    canonicalModelId,
    openCodeGoModelOptions,
    openRouterModelOptions,
    vercelModelOptions,
    type ModelOption,
} from "@/app/components/assistant/ModelToggle";
import { MODEL_TOGGLE_GROUPS } from "@/shared/ui/ModelToggleUI";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { SettingsSection } from "../SettingsSection";
import { CommitteeSettingsSection } from "@/app/components/settings/CommitteeSettingsSection";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";

type ModelPreferenceField = "titleModel" | "tabularModel";

export default function ModelPreferencesPage() {
    const { profile, updateModelPreference } = useUserProfile();
    const ollamaModels = useOllamaModels();
    const [savingField, setSavingField] = useState<ModelPreferenceField | null>(
        null,
    );
    const [savedField, setSavedField] = useState<ModelPreferenceField | null>(
        null,
    );
    const [optimisticValues, setOptimisticValues] = useState<
        Partial<Record<ModelPreferenceField, string>>
    >({});
    const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const openRouterSelection = profile?.openRouterModels ?? [];
    const vercelSelection = profile?.vercelModels ?? [];
    const selectedOpenRouterOptions =
        openRouterModelOptions(openRouterSelection);
    const selectedVercelOptions = vercelModelOptions(vercelSelection);
    const selectedOpenCodeGoOptions = openCodeGoModelOptions(
        profile?.openCodeGoModels ?? [],
    );

    useEffect(() => {
        return () => {
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        };
    }, []);

    const handleModelChange = async (
        field: ModelPreferenceField,
        id: string,
    ) => {
        setOptimisticValues((current) => ({ ...current, [field]: id }));
        setSavedField(null);
        setSavingField(field);
        const ok = await updateModelPreference(field, id);
        setSavingField((current) => (current === field ? null : current));
        if (ok) {
            setSavedField(field);
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => {
                setSavedField((current) =>
                    current === field ? null : current,
                );
            }, 1600);
        } else {
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
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Model Preferences
                </h2>
                <SettingsSection>
                    <div className="px-4 py-5">
                        <FieldLabel>Title generation model</FieldLabel>
                        <p className="text-xs text-gray-400 mb-2">
                            Used for naming chats and other lightweight titles.
                        </p>
                        <ModelPreferenceDropdown
                            value={canonicalModelId(
                                optimisticValues.titleModel ??
                                    profile?.titleModel ??
                                    "gemini-3.5-flash-lite",
                            )}
                            options={[
                                ...SETTINGS_MODELS,
                                ...selectedOpenRouterOptions,
                                ...selectedVercelOptions,
                                ...selectedOpenCodeGoOptions,
                                ...ollamaModels,
                            ]}
                            apiKeys={profile?.apiKeys}
                            isSaving={savingField === "titleModel"}
                            isSaved={savedField === "titleModel"}
                            onChange={(id) =>
                                handleModelChange("titleModel", id)
                            }
                        />
                    </div>
                    <div className="px-4 py-5">
                        <FieldLabel>Tabular review model</FieldLabel>
                        <p className="text-xs text-gray-400 mb-2">
                            We recommend using a smaller model for tabular
                            reviews to reduce token costs.
                        </p>
                        <ModelPreferenceDropdown
                            value={canonicalModelId(
                                optimisticValues.tabularModel ??
                                    profile?.tabularModel ??
                                    "gemini-3-flash-preview",
                            )}
                            options={[
                                ...MODELS,
                                ...selectedOpenRouterOptions,
                                ...selectedVercelOptions,
                                ...selectedOpenCodeGoOptions,
                                ...ollamaModels,
                            ]}
                            apiKeys={profile?.apiKeys}
                            isSaving={savingField === "tabularModel"}
                            isSaved={savedField === "tabularModel"}
                            onChange={(id) =>
                                handleModelChange("tabularModel", id)
                            }
                        />
                    </div>
                </SettingsSection>
            </section>
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Committees
                </h2>
                <CommitteeSettingsSection
                    options={[
                        ...MODELS,
                        ...selectedOpenRouterOptions,
                        ...selectedVercelOptions,
                        ...selectedOpenCodeGoOptions,
                        ...ollamaModels,
                    ]}
                    apiKeys={profile?.apiKeys}
                />
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
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    options: ModelOption[];
    isSaving?: boolean;
    isSaved?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const availableOptions = options.filter((model) => {
        if (model.group === "Local") return true;
        return apiKeys ? isModelAvailable(model.id, apiKeys) : false;
    });
    const selected = availableOptions.find((model) => model.id === value);
    const availableGroups = MODEL_TOGGLE_GROUPS.flatMap((group) => {
        const items = availableOptions.filter((model) => model.group === group);
        return items.length ? [{ group, items }] : [];
    });

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    disabled={isSaving || availableOptions.length === 0}
                    className={`flex h-9 items-center justify-between gap-2 hover:bg-gray-200/70 ${SETTINGS_CONTROL_CLASS}`}
                >
                    <span className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-gray-900">
                            {selected?.label ??
                                (availableOptions.length
                                    ? "Select a model"
                                    : "No available models")}
                        </span>
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
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {availableGroups.map(({ group, items }, groupIndex) => {
                    return (
                        <div key={group}>
                            {groupIndex > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                return (
                                    <LiquidDropdownItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                    >
                                        <span className="flex-1">
                                            {m.label}
                                        </span>
                                        {m.id === value && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </LiquidDropdownItem>
                                );
                            })}
                        </div>
                    );
                })}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}

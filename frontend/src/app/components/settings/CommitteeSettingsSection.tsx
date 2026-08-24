"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";
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
import { FieldLabel } from "@/app/components/ui/form-field";
import { OptionPill } from "@/app/components/ui/option-pill";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    MAX_COMMITTEE_MEMBERS,
    MAX_USER_COMMITTEES,
    MIN_COMMITTEE_MEMBERS,
    USER_COMMITTEE_PREFIX,
    type ApiKeyState,
    type ModelCommittee,
} from "@/app/lib/mikeApi";
import type { ModelOption } from "@/app/components/assistant/ModelToggle";
import { MODEL_TOGGLE_GROUPS } from "@/shared/ui/ModelToggleUI";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import { SettingsSection } from "@/app/(pages)/settings/SettingsSection";

const MAX_LABEL_LENGTH = 80;

function newCommitteeId(): string {
    const unique =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${USER_COMMITTEE_PREFIX}${unique}`;
}

/** What stops a committee from being saved, or null when it is ready. */
function committeeProblem(committee: ModelCommittee): string | null {
    if (!committee.label.trim()) return "Give the committee a name.";
    if (committee.label.length > MAX_LABEL_LENGTH) {
        return `Names must be ${MAX_LABEL_LENGTH} characters or fewer.`;
    }
    if (committee.members.length < MIN_COMMITTEE_MEMBERS) {
        return `Add at least ${MIN_COMMITTEE_MEMBERS} members.`;
    }
    if (!committee.chair) return "Choose a chair model.";
    return null;
}

function ModelSelect({
    value,
    placeholder,
    options,
    exclude = [],
    onChange,
    ariaLabel,
}: {
    value: string;
    placeholder: string;
    options: ModelOption[];
    exclude?: string[];
    onChange: (id: string) => void;
    ariaLabel: string;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const choices = options.filter((option) => !exclude.includes(option.id));
    const selected = choices.find((option) => option.id === value);
    const groups = MODEL_TOGGLE_GROUPS.flatMap((group) => {
        const items = choices.filter((option) => option.group === group);
        return items.length ? [{ group, items }] : [];
    });

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={ariaLabel}
                    disabled={choices.length === 0}
                    className={`flex h-9 items-center justify-between gap-2 hover:bg-gray-200/70 ${SETTINGS_CONTROL_CLASS}`}
                >
                    <span className="truncate text-gray-900">
                        {selected?.label ??
                            (choices.length ? placeholder : "No models available")}
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {groups.map(({ group, items }, groupIndex) => (
                    <div key={group}>
                        {groupIndex > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                            {group}
                        </DropdownMenuLabel>
                        {items.map((option) => (
                            <LiquidDropdownItem
                                key={option.id}
                                className="cursor-pointer"
                                onSelect={() => onChange(option.id)}
                            >
                                <span className="flex-1">{option.label}</span>
                                {option.id === value && (
                                    <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />
                                )}
                            </LiquidDropdownItem>
                        ))}
                    </div>
                ))}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}

export function CommitteeSettingsSection({
    options,
    apiKeys,
}: {
    options: ModelOption[];
    apiKeys?: ApiKeyState;
}) {
    const { profile, updateModelCommittees } = useUserProfile();
    const saved = useMemo(
        () => profile?.modelCommittees ?? [],
        [profile?.modelCommittees],
    );
    const [drafts, setDrafts] = useState<ModelCommittee[]>(saved);
    const [syncedFrom, setSyncedFrom] = useState(saved);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Follow the profile whenever it reloads. Local edits are per-card and
    // committed explicitly, so there is no half-typed state to protect.
    if (syncedFrom !== saved) {
        setSyncedFrom(saved);
        setDrafts(saved);
    }

    // A committee can only contain models the user can actually run, or it
    // would be offered in the picker and then fail at request time.
    const selectable = useMemo(
        () =>
            options.filter((option) =>
                option.group === "Local"
                    ? true
                    : apiKeys
                      ? isModelAvailable(option.id, apiKeys)
                      : false,
            ),
        [options, apiKeys],
    );
    const labelFor = (id: string) =>
        selectable.find((option) => option.id === id)?.label ?? id;

    const patch = (id: string, changes: Partial<ModelCommittee>) => {
        setError(null);
        setDrafts((current) =>
            current.map((committee) =>
                committee.id === id ? { ...committee, ...changes } : committee,
            ),
        );
    };

    const persist = async (next: ModelCommittee[], id: string | null) => {
        setSavingId(id);
        const ok = await updateModelCommittees(next);
        setSavingId(null);
        if (!ok) {
            setError("Could not save your committees. Try again.");
            return false;
        }
        setError(null);
        return true;
    };

    const addCommittee = () => {
        setError(null);
        setDrafts((current) => [
            ...current,
            {
                id: newCommitteeId(),
                label: "",
                members: [],
                chair: "",
                strategy: "synthesize",
            },
        ]);
    };

    const saveCommittee = async (committee: ModelCommittee) => {
        const problem = committeeProblem(committee);
        if (problem) {
            setError(problem);
            return;
        }
        // Only complete committees are sent; a half-built card stays local.
        const next = drafts
            .map((entry) => (entry.id === committee.id ? committee : entry))
            .filter((entry) => committeeProblem(entry) === null);
        await persist(next, committee.id);
    };

    const removeCommittee = async (id: string) => {
        const next = drafts
            .filter((committee) => committee.id !== id)
            .filter((committee) => committeeProblem(committee) === null);
        const wasSaved = saved.some((committee) => committee.id === id);
        setDrafts((current) =>
            current.filter((committee) => committee.id !== id),
        );
        if (wasSaved) await persist(next, id);
    };

    return (
        <SettingsSection>
            <div className="space-y-4 px-4 py-5">
                <div>
                    <FieldLabel>Committees</FieldLabel>
                    <p className="text-xs text-gray-400">
                        A committee sends your message to several models at
                        once and has a chair model combine their answers into
                        one. Committees appear in the model picker alongside
                        individual models.
                    </p>
                </div>

                {drafts.length === 0 && (
                    <p className="text-sm text-gray-500">
                        You have not created any committees yet.
                    </p>
                )}

                {drafts.map((committee) => {
                    const problem = committeeProblem(committee);
                    const isSaving = savingId === committee.id;
                    const memberOptions = committee.chair
                        ? [committee.chair, ...committee.members]
                        : committee.members;
                    return (
                        <div
                            key={committee.id}
                            className="space-y-3 rounded-xl border border-gray-200/70 p-3"
                        >
                            <div className="flex items-start gap-2">
                                <input
                                    type="text"
                                    value={committee.label}
                                    maxLength={MAX_LABEL_LENGTH}
                                    placeholder="Committee name"
                                    aria-label="Committee name"
                                    onChange={(event) =>
                                        patch(committee.id, {
                                            label: event.target.value,
                                        })
                                    }
                                    className={`h-9 flex-1 ${SETTINGS_CONTROL_CLASS}`}
                                />
                                <button
                                    type="button"
                                    aria-label={`Delete ${committee.label || "committee"}`}
                                    title="Delete committee"
                                    disabled={isSaving}
                                    onClick={() =>
                                        void removeCommittee(committee.id)
                                    }
                                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200/70 hover:text-gray-700 disabled:opacity-40"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </div>

                            <div>
                                <FieldLabel>Members</FieldLabel>
                                {committee.members.length > 0 && (
                                    <div className="mb-2 mt-1 flex flex-wrap gap-1.5">
                                        {committee.members.map((member) => (
                                            <OptionPill
                                                key={member}
                                                disabled={isSaving}
                                                aria-label={`Remove ${labelFor(member)}`}
                                                title={`Remove ${labelFor(member)}`}
                                                onClick={() =>
                                                    patch(committee.id, {
                                                        members:
                                                            committee.members.filter(
                                                                (entry) =>
                                                                    entry !==
                                                                    member,
                                                            ),
                                                    })
                                                }
                                            >
                                                {labelFor(member)}
                                            </OptionPill>
                                        ))}
                                    </div>
                                )}
                                {committee.members.length <
                                    MAX_COMMITTEE_MEMBERS && (
                                    <ModelSelect
                                        value=""
                                        placeholder="Add a member"
                                        ariaLabel="Add a committee member"
                                        options={selectable}
                                        exclude={memberOptions}
                                        onChange={(id) =>
                                            patch(committee.id, {
                                                members: [
                                                    ...committee.members,
                                                    id,
                                                ],
                                            })
                                        }
                                    />
                                )}
                            </div>

                            <div>
                                <FieldLabel>Chair</FieldLabel>
                                <p className="mb-1 text-xs text-gray-400">
                                    Combines the members&apos; answers into the
                                    final response.
                                </p>
                                <ModelSelect
                                    value={committee.chair}
                                    placeholder="Choose a chair"
                                    ariaLabel="Committee chair model"
                                    options={selectable}
                                    exclude={committee.members}
                                    onChange={(id) =>
                                        patch(committee.id, { chair: id })
                                    }
                                />
                            </div>

                            <div className="flex items-center justify-between gap-3">
                                <p className="text-xs text-gray-400">
                                    {problem ?? "Ready to use."}
                                </p>
                                <button
                                    type="button"
                                    disabled={isSaving || problem !== null}
                                    onClick={() => void saveCommittee(committee)}
                                    className="flex h-8 items-center gap-1.5 rounded-lg bg-gray-900 px-3 text-xs font-medium text-white transition-colors hover:bg-gray-700 disabled:cursor-default disabled:opacity-40"
                                >
                                    {isSaving && (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    )}
                                    Save committee
                                </button>
                            </div>
                        </div>
                    );
                })}

                {error && (
                    <p role="alert" className="text-xs text-red-600">
                        {error}
                    </p>
                )}

                {drafts.length < MAX_USER_COMMITTEES && (
                    <button
                        type="button"
                        onClick={addCommittee}
                        className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-gray-600 transition-colors hover:bg-gray-200/70 hover:text-gray-900"
                    >
                        <Plus className="h-4 w-4" />
                        New committee
                    </button>
                )}
            </div>
        </SettingsSection>
    );
}

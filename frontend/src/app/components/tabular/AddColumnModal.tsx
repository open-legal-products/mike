"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import type { ColumnConfig, ColumnFormat } from "../shared/types";
import { generateTabularColumnPrompt } from "@/app/lib/mikeApi";
import { FORMAT_OPTIONS } from "./columnFormat";
import { TAG_COLORS } from "./pillUtils";
import { getPresetConfig, PROMPT_PRESETS } from "./columnPresets";
import { Modal } from "../modals/Modal";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextarea } from "../modals/ModalTextarea";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import {
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

interface ColumnDraft {
    name: string;
    prompt: string;
    format: ColumnFormat;
    tags: string[];
    tagInput: string;
}

const EMPTY_DRAFT: ColumnDraft = {
    name: "",
    prompt: "",
    format: "text",
    tags: [],
    tagInput: "",
};

interface Props {
    open: boolean;
    existingCount: number;
    onClose: () => void;
    onAdd: (cols: ColumnConfig[]) => void;
}

export function AddColumnModal({
    open,
    existingCount,
    onClose,
    onAdd,
}: Props) {
    const formId = "add-column-modal-form";
    const [columns, setColumns] = useState<ColumnDraft[]>([{ ...EMPTY_DRAFT }]);
    const [collapsedIndices, setCollapsedIndices] = useState<number[]>([]);
    const [generatingIndices, setGeneratingIndices] = useState<number[]>([]);
    const [presetsOpenIndex, setPresetsOpenIndex] = useState<number | null>(
        null,
    );
    const presetsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        setColumns([{ ...EMPTY_DRAFT }]);
        setCollapsedIndices([]);
    }, [open]);

    useEffect(() => {
        if (presetsOpenIndex === null) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                presetsRef.current &&
                !presetsRef.current.contains(e.target as Node)
            ) {
                setPresetsOpenIndex(null);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [presetsOpenIndex]);

    if (!open) return null;

    function resetForm() {
        setColumns([{ ...EMPTY_DRAFT }]);
        setCollapsedIndices([]);
        setGeneratingIndices([]);
    }

    function handleClose() {
        resetForm();
        onClose();
    }

    function updateColumn(index: number, patch: Partial<ColumnDraft>) {
        setColumns((prev) =>
            prev.map((col, i) => (i === index ? { ...col, ...patch } : col)),
        );
    }

    function addAnotherColumn() {
        setColumns((prev) => [...prev, { ...EMPTY_DRAFT }]);
    }

    function removeColumn(index: number) {
        setColumns((prev) =>
            prev.length === 1
                ? [{ ...EMPTY_DRAFT }]
                : prev.filter((_, i) => i !== index),
        );
        setCollapsedIndices((prev) =>
            prev
                .filter((collapsedIndex) => collapsedIndex !== index)
                .map((collapsedIndex) =>
                    collapsedIndex > index
                        ? collapsedIndex - 1
                        : collapsedIndex,
                ),
        );
    }

    function toggleColumnCollapsed(index: number) {
        setCollapsedIndices((prev) =>
            prev.includes(index)
                ? prev.filter((collapsedIndex) => collapsedIndex !== index)
                : [...prev, index],
        );
        setPresetsOpenIndex(null);
    }

    function commitTag(index: number) {
        setColumns((prev) => {
            const col = prev[index]!;
            const tag = col.tagInput.trim();
            if (!tag || col.tags.includes(tag)) {
                return prev.map((c, i) =>
                    i === index ? { ...c, tagInput: "" } : c,
                );
            }
            return prev.map((c, i) =>
                i === index
                    ? { ...c, tags: [...c.tags, tag], tagInput: "" }
                    : c,
            );
        });
    }

    function handleTagKeyDown(
        e: React.KeyboardEvent<HTMLInputElement>,
        index: number,
    ) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitTag(index);
        } else if (
            e.key === "Backspace" &&
            columns[index]!.tagInput === "" &&
            columns[index]!.tags.length > 0
        ) {
            updateColumn(index, {
                tags: columns[index]!.tags.slice(0, -1),
            });
        }
    }

    async function autoGeneratePrompt(index: number) {
        const title = columns[index]?.name?.trim() ?? "";
        if (!title) return;
        setGeneratingIndices((prev) => [...prev, index]);
        try {
            const col = columns[index]!;
            const { prompt } = await generateTabularColumnPrompt(title, {
                format: col.format,
                tags: col.format === "tag" ? col.tags : undefined,
            });
            updateColumn(index, { prompt });
        } finally {
            setGeneratingIndices((prev) => prev.filter((v) => v !== index));
        }
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (columns.some((col) => !col.name.trim() || !col.prompt.trim()))
            return;
        onAdd(
            columns.map((col, i) => ({
                index: existingCount + i,
                name: col.name.trim(),
                prompt: col.prompt.trim(),
                format: col.format,
                tags: col.format === "tag" ? col.tags : undefined,
            })),
        );
        resetForm();
        onClose();
    }

    return (
        <Modal
            open={open}
            onClose={handleClose}
            breadcrumbs={["Tabular Review", "New column"]}
            primaryAction={{
                label: "Add columns",
                type: "submit",
                form: formId,
                disabled: columns.some(
                    (col) => !col.name.trim() || !col.prompt.trim(),
                ),
            }}
            cancelAction={{ label: "Cancel", onClick: handleClose }}
        >
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex min-h-0 flex-1 flex-col"
            >
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3">
                        {columns.map((column, index) => (
                            <div
                                key={index}
                                className="relative"
                            >
                                {(() => {
                                    const nameInputId = `column-${index}-name`;
                                    const formatInputId = `column-${index}-format`;
                                    const tagInputId = `column-${index}-tag`;
                                    const promptInputId = `column-${index}-prompt`;
                                    const isCollapsed =
                                        collapsedIndices.includes(index);

                                    return (
                                        <>
                                            <div className="mb-4 flex items-center justify-between gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        toggleColumnCollapsed(
                                                            index,
                                                        )
                                                    }
                                                    aria-expanded={!isCollapsed}
                                                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-gray-300"
                                                >
                                                    <ChevronDown
                                                        className={`h-4 w-4 shrink-0 text-gray-600 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                                                    />
                                                    <h3 className="font-serif text-2xl text-gray-950">
                                                        Column {index + 1}
                                                    </h3>
                                                </button>
                                                {columns.length > 1 && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            removeColumn(index)
                                                        }
                                                        className="rounded-lg p-1.5 text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-500"
                                                        aria-label="Remove column"
                                                    >
                                                        <X className="h-4 w-4" />
                                                    </button>
                                                )}
                                            </div>
                                            {!isCollapsed && (
                                                <>
                                            <FieldLabel htmlFor={nameInputId}>
                                                Column title
                                            </FieldLabel>
                                {/* Name row */}
                                <div className="flex items-start gap-2">
                                    {/* Input + preset dropdown anchored to this wrapper */}
                                    <div
                                        className="relative flex flex-1 items-start"
                                        ref={
                                            presetsOpenIndex === index
                                                ? presetsRef
                                                : null
                                        }
                                    >
                                        <FormTextInput
                                            id={nameInputId}
                                            type="text"
                                            variant="minimal"
                                            value={column.name}
                                            onChange={(e) => {
                                                const name = e.target.value;
                                                const preset =
                                                    getPresetConfig(name);
                                                updateColumn(index, {
                                                    name,
                                                    ...(preset
                                                        ? {
                                                              prompt: preset.prompt,
                                                              format: preset.format,
                                                              tags:
                                                                  preset.tags ??
                                                                  [],
                                                              tagInput: "",
                                                          }
                                                        : {}),
                                                });
                                            }}
                                            placeholder="Column name"
                                            className="flex-1"
                                            autoFocus={index === 0}
                                        />
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setPresetsOpenIndex(
                                                    presetsOpenIndex === index
                                                        ? null
                                                        : index,
                                                )
                                            }
                                            title="Column presets"
                                            className="mt-1.5 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                                        >
                                            <ChevronDown
                                                className={`h-4 w-4 transition-transform ${presetsOpenIndex === index ? "rotate-180" : ""}`}
                                            />
                                        </button>
                                        {presetsOpenIndex === index && (
                                            <div className={`absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`}>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        updateColumn(index, { ...EMPTY_DRAFT });
                                                        setPresetsOpenIndex(null);
                                                    }}
                                                    className="theme-dropdown-item w-full border-b border-gray-100 px-3 py-2 text-left text-sm text-gray-400 transition-colors"
                                                >
                                                    No Preset
                                                </button>
                                                {PROMPT_PRESETS.map(
                                                    (preset) => (
                                                        <button
                                                            key={preset.name}
                                                            type="button"
                                                            onClick={() => {
                                                                updateColumn(
                                                                    index,
                                                                    {
                                                                        name: preset.name,
                                                                        prompt: preset.prompt,
                                                                        format: preset.format,
                                                                        tags:
                                                                            preset.tags ??
                                                                            [],
                                                                        tagInput:
                                                                            "",
                                                                    },
                                                                );
                                                                setPresetsOpenIndex(
                                                                    null,
                                                                );
                                                            }}
                                                            className="theme-dropdown-item w-full px-3 py-2 text-left text-sm text-gray-700 transition-colors"
                                                        >
                                                            {preset.name}
                                                        </button>
                                                    ),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Format */}
                                <div className="mt-4">
                                    <FieldLabel htmlFor={formatInputId}>
                                        Format
                                    </FieldLabel>
                                    <ModalSelect
                                        id={formatInputId}
                                        value={column.format}
                                        options={FORMAT_OPTIONS.map((option) => ({
                                            value: option.value,
                                            label: option.label,
                                            icon: option.icon,
                                            iconClassName: option.iconClassName,
                                        }))}
                                        onChange={(value) =>
                                            updateColumn(index, {
                                                format: value as ColumnFormat,
                                                tags: [],
                                                tagInput: "",
                                            })
                                        }
                                    />
                                </div>

                                {/* Tag input */}
                                {column.format === "tag" && (
                                    <div className="mt-3">
                                        <FieldLabel htmlFor={tagInputId}>
                                            Tags
                                        </FieldLabel>
                                        <div
                                            className={`mt-1 flex flex-wrap gap-1.5 rounded-xl px-2 py-1.5 ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl`}
                                        >
                                            {column.tags.map((tag, tagIdx) => (
                                                <span
                                                    key={tag}
                                                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${TAG_COLORS[tagIdx % TAG_COLORS.length]}`}
                                                >
                                                    {tag}
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            updateColumn(
                                                                index,
                                                                {
                                                                    tags: column.tags.filter(
                                                                        (t) =>
                                                                            t !==
                                                                            tag,
                                                                    ),
                                                                },
                                                            )
                                                        }
                                                        className="text-gray-400 hover:text-gray-600"
                                                    >
                                                        <X className="h-2.5 w-2.5" />
                                                    </button>
                                                </span>
                                            ))}
                                            <FormTextInput
                                                id={tagInputId}
                                                type="text"
                                                variant="minimal"
                                                value={column.tagInput}
                                                onChange={(e) =>
                                                    updateColumn(index, {
                                                        tagInput:
                                                            e.target.value,
                                                    })
                                                }
                                                onKeyDown={(e) =>
                                                    handleTagKeyDown(e, index)
                                                }
                                                onBlur={() => commitTag(index)}
                                                placeholder="Add tag…"
                                                className="min-w-[80px] flex-1 bg-transparent font-sans text-sm text-gray-700 shadow-none placeholder:text-gray-400"
                                            />
                                        </div>
                                        <p className="mt-1 text-xs text-gray-400">
                                            Press Enter or comma to add a tag.
                                        </p>
                                    </div>
                                )}

                                {/* Prompt */}
                                <div className="mt-4 flex items-center justify-between">
                                    <FieldLabel htmlFor={promptInputId}>
                                        Prompt
                                    </FieldLabel>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            autoGeneratePrompt(index)
                                        }
                                        disabled={
                                            !column.name.trim() ||
                                            generatingIndices.includes(index)
                                        }
                                        className="inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900 disabled:text-gray-300"
                                    >
                                        {generatingIndices.includes(index) ? (
                                            <span className="h-4 w-4 rounded-full border-2 border-gray-300 border-t-gray-600 animate-spin block" />
                                        ) : (
                                            <Plus className="h-4 w-4" />
                                        )}
                                        Auto-Generate Prompt
                                    </button>
                                </div>
                                <ModalTextarea
                                    id={promptInputId}
                                    rows={6}
                                    value={column.prompt}
                                    onChange={(e) =>
                                        updateColumn(index, {
                                            prompt: e.target.value,
                                        })
                                    }
                                    placeholder="Write the analysis prompt — describe what Mike should extract from each document for this column…"
                                    className="mt-2 min-h-36"
                                />
                                                </>
                                            )}
                                        </>
                                    );
                                })()}
                            </div>
                        ))}

                        <button
                            type="button"
                            onClick={addAnotherColumn}
                            className="inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900"
                        >
                            <Plus className="h-4 w-4" />
                            Add another column
                        </button>
                </div>
            </form>
        </Modal>
    );
}

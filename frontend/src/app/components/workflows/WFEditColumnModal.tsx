"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ColumnConfig, ColumnFormat } from "../shared/types";
import { generateTabularColumnPrompt } from "@/app/lib/mikeApi";
import { FORMAT_OPTIONS } from "../tabular/columnFormat";
import { TAG_COLORS } from "../tabular/pillUtils";
import { getPresetConfig, PROMPT_PRESETS } from "../tabular/columnPresets";
import { Modal } from "../modals/Modal";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextarea } from "../modals/ModalTextarea";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";

interface ColumnDraft {
    name: string;
    prompt: string;
    format: ColumnFormat;
    tags: string[];
    tagInput: string;
}

interface Props {
    column: ColumnConfig;
    onClose: () => void;
    onSave: (col: ColumnConfig) => void;
    onDelete: () => void;
}

export function WFEditColumnModal({ column, onClose, onSave, onDelete }: Props) {
    const t = useTranslations("workflows.editarColunaModal");
    const formId = "workflow-edit-column-modal-form";
    const [draft, setDraft] = useState<ColumnDraft>({
        name: column.name,
        prompt: column.prompt,
        format: column.format ?? "text",
        tags: column.tags ?? [],
        tagInput: "",
    });
    const [generating, setGenerating] = useState(false);
    const [presetsOpen, setPresetsOpen] = useState(false);
    const presetsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setDraft({
            name: column.name,
            prompt: column.prompt,
            format: column.format ?? "text",
            tags: column.tags ?? [],
            tagInput: "",
        });
        setPresetsOpen(false);
    }, [column]);

    useEffect(() => {
        if (!presetsOpen) return;
        function handleClickOutside(e: MouseEvent) {
            if (presetsRef.current && !presetsRef.current.contains(e.target as Node)) {
                setPresetsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [presetsOpen]);

    function update(patch: Partial<ColumnDraft>) {
        setDraft((prev) => ({ ...prev, ...patch }));
    }

    function commitTag() {
        const tag = draft.tagInput.trim();
        if (!tag || draft.tags.includes(tag)) {
            update({ tagInput: "" });
            return;
        }
        update({ tags: [...draft.tags, tag], tagInput: "" });
    }

    function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitTag();
        } else if (e.key === "Backspace" && draft.tagInput === "" && draft.tags.length > 0) {
            update({ tags: draft.tags.slice(0, -1) });
        }
    }

    async function autoGeneratePrompt() {
        const title = draft.name.trim();
        if (!title) return;
        setGenerating(true);
        try {
            const { prompt } = await generateTabularColumnPrompt(title, {
                format: draft.format,
                tags: draft.format === "tag" ? draft.tags : undefined,
            });
            update({ prompt });
        } finally {
            setGenerating(false);
        }
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!draft.name.trim() || !draft.prompt.trim()) return;
        onSave({
            index: column.index,
            name: draft.name.trim(),
            prompt: draft.prompt.trim(),
            format: draft.format,
            tags: draft.format === "tag" ? draft.tags : undefined,
        });
    }

    return (
        <Modal
            open
            onClose={onClose}
            breadcrumbs={[t("breadcrumb"), t("editarColuna")]}
            primaryAction={{
                label: t("salvarAlteracoes"),
                type: "submit",
                form: formId,
                disabled: !draft.name.trim() || !draft.prompt.trim(),
            }}
            cancelAction={{ label: t("cancelar"), onClick: onClose }}
            secondaryAction={{
                label: t("excluir"),
                variant: "danger",
                onClick: onDelete,
            }}
        >
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex min-h-0 flex-1 flex-col"
            >
                <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-5 pt-2">
                        <FieldLabel htmlFor="workflow-column-name">
                            {t("tituloColuna")}
                        </FieldLabel>
                        {/* Name row */}
                        <div className="flex items-start gap-2">
                            <div className="relative flex flex-1 items-start" ref={presetsRef}>
                                <FormTextInput
                                    id="workflow-column-name"
                                    type="text"
                                    variant="minimal"
                                    value={draft.name}
                                    onChange={(e) => {
                                        const name = e.target.value;
                                        const preset = getPresetConfig(name);
                                        update({
                                            name,
                                            ...(preset ? {
                                                prompt: preset.prompt,
                                                format: preset.format,
                                                tags: preset.tags ?? [],
                                                tagInput: "",
                                            } : {}),
                                        });
                                    }}
                                    placeholder={t("placeholderNome")}
                                    className="flex-1"
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    onClick={() => setPresetsOpen((v) => !v)}
                                    title={t("modelosDeColuna")}
                                    className="mt-1.5 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100/70 hover:text-gray-700"
                                >
                                    <ChevronDown className={`h-4 w-4 transition-transform ${presetsOpen ? "rotate-180" : ""}`} />
                                </button>
                                {presetsOpen && (
                                    <div className={`absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`}>
                                        <button
                                            type="button"
                                            onClick={() => { update({ name: "", prompt: "", format: "text", tags: [], tagInput: "" }); setPresetsOpen(false); }}
                                            className="theme-dropdown-item w-full border-b border-gray-100 px-3 py-2 text-left text-sm text-gray-400 transition-all"
                                        >
                                            {t("semModelo")}
                                        </button>
                                        {PROMPT_PRESETS.map((preset) => (
                                            <button
                                                key={preset.name}
                                                type="button"
                                                onClick={() => {
                                                    update({ name: preset.name, prompt: preset.prompt, format: preset.format, tags: preset.tags ?? [], tagInput: "" });
                                                    setPresetsOpen(false);
                                                }}
                                                className="theme-dropdown-item w-full px-3 py-2 text-left text-sm text-gray-700 transition-all"
                                            >
                                                {preset.name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Format */}
                        <div className="mt-4">
                            <FieldLabel htmlFor="workflow-column-format">
                                {t("formato")}
                            </FieldLabel>
                            <ModalSelect
                                id="workflow-column-format"
                                value={draft.format}
                                options={FORMAT_OPTIONS.map((option) => ({
                                    value: option.value,
                                    label: option.label,
                                    icon: option.icon,
                                    iconClassName: option.iconClassName,
                                }))}
                                onChange={(value) =>
                                    update({
                                        format: value as ColumnFormat,
                                        tags: [],
                                        tagInput: "",
                                    })
                                }
                            />
                        </div>

                        {/* Tag input */}
                        {draft.format === "tag" && (
                            <div className="mt-3">
                                <FieldLabel htmlFor="workflow-column-tag">
                                    {t("etiquetas")}
                                </FieldLabel>
                                <div className="mt-1 flex flex-wrap gap-1.5 rounded-md border border-gray-200 px-2 py-1.5 focus-within:border-gray-400">
                                    {draft.tags.map((tag, tagIdx) => (
                                        <span
                                            key={tag}
                                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${TAG_COLORS[tagIdx % TAG_COLORS.length]}`}
                                        >
                                            {tag}
                                            <button
                                                type="button"
                                                onClick={() => update({ tags: draft.tags.filter((t) => t !== tag) })}
                                                className="text-gray-400 hover:text-gray-600"
                                            >
                                                <X className="h-2.5 w-2.5" />
                                            </button>
                                        </span>
                                    ))}
                                    <FormTextInput
                                        id="workflow-column-tag"
                                        type="text"
                                        variant="minimal"
                                        value={draft.tagInput}
                                        onChange={(e) => update({ tagInput: e.target.value })}
                                        onKeyDown={handleTagKeyDown}
                                        onBlur={commitTag}
                                        placeholder={t("adicionarEtiqueta")}
                                        className="min-w-[80px] flex-1 font-sans text-sm text-gray-700 placeholder:text-gray-400"
                                    />
                                </div>
                                <p className="mt-1 text-xs text-gray-400">{t("instrucaoEtiqueta")}</p>
                            </div>
                        )}

                        {/* Prompt */}
                        <div className="mt-4 flex items-center justify-between">
                            <FieldLabel htmlFor="workflow-column-prompt">
                                {t("prompt")}
                            </FieldLabel>
                            <button
                                type="button"
                                onClick={autoGeneratePrompt}
                                disabled={!draft.name.trim() || generating}
                                className="inline-flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-gray-900 disabled:text-gray-300"
                            >
                                {generating ? (
                                    <span className="h-4 w-4 rounded-full border-2 border-gray-300 border-t-gray-600 animate-spin block" />
                                ) : (
                                    <Plus className="h-4 w-4" />
                                )}
                                {t("gerarPrompt")}
                            </button>
                        </div>
                        <ModalTextarea
                            id="workflow-column-prompt"
                            rows={6}
                            value={draft.prompt}
                            onChange={(e) => update({ prompt: e.target.value })}
                            placeholder={t("placeholderPrompt")}
                            className="mt-2 min-h-36"
                        />
                </div>
            </form>
        </Modal>
    );
}

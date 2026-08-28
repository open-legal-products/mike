"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import type { AssistantEvent, Document, MessageFile } from "../shared/types";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import {
    LIQUID_GLASS_SUBTLE_CLASS,
    LIQUID_GLASS_TRANSLUCENT_CLASS,
} from "@/app/components/ui/liquid-surface";

type AskInputsEvent = Extract<AssistantEvent, { type: "ask_inputs" }>;
type AskInputItem = AskInputsEvent["items"][number];
type AskInputsResponse = Extract<
    AssistantEvent,
    { type: "ask_inputs_response" }
>;

const OPEN_TEXT_MAX_LENGTH = 5_000;

export function AskInputPopup({
    event,
    onSubmit,
    onDismiss,
}: {
    event: AskInputsEvent;
    onSubmit?: (
        response: AskInputsResponse,
        content: string,
        files: MessageFile[],
    ) => void;
    onDismiss?: () => void;
}) {
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
    const [otherValues, setOtherValues] = useState<Record<string, string>>({});
    const [docsByInput, setDocsByInput] = useState<
        Record<string, Record<number, Document[]>>
    >({});
    const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
    const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set());
    const [submitted, setSubmitted] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [docSelectorTarget, setDocSelectorTarget] = useState<{
        inputId: string;
        typeIndex: number;
    } | null>(null);
    const [activeInputId, setActiveInputId] = useState(
        () => event.items[0]?.id ?? "",
    );

    const docsForItem = useCallback(
        (inputId: string) => {
            const seen = new Set<string>();
            return Object.values(docsByInput[inputId] ?? {})
                .flat()
                .filter((doc) => {
                    if (seen.has(doc.id)) return false;
                    seen.add(doc.id);
                    return true;
                });
        },
        [docsByInput],
    );

    const clearConfirmation = (id: string) => {
        setConfirmed((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    };

    const itemAnswered = useCallback(
        (item: AskInputItem) => {
            if (item.kind !== "documents") {
                return !!answers[item.id]?.trim();
            }
            return docsForItem(item.id).length > 0;
        },
        [answers, docsForItem],
    );

    const itemResolved = useCallback(
        (item: AskInputItem) =>
            skipped.has(item.id) ||
            (confirmed.has(item.id) && itemAnswered(item)),
        [confirmed, itemAnswered, skipped],
    );

    const firstUnresolvedId = useCallback(
        (resolvedId?: string) =>
            event.items.find((item) => {
                if (item.id === resolvedId) return false;
                return !itemResolved(item);
            })?.id ?? null,
        [event.items, itemResolved],
    );

    const goToNextUnresolved = useCallback(
        (resolvedId: string) => {
            const nextId = firstUnresolvedId(resolvedId);
            if (nextId) setActiveInputId(nextId);
        },
        [firstUnresolvedId],
    );

    const setSkippedFor = (id: string, shouldSkip = true) => {
        if (shouldSkip) clearConfirmation(id);
        setSkipped((prev) => {
            const next = new Set(prev);
            if (shouldSkip) next.add(id);
            else next.delete(id);
            return next;
        });
        if (shouldSkip) goToNextUnresolved(id);
    };

    const confirmItem = (id: string) => {
        setConfirmed((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
        });
        goToNextUnresolved(id);
    };

    const addDocs = (
        inputId: string,
        typeIndex: number,
        selected: Document[],
    ) => {
        if (selected.length === 0) return;
        clearConfirmation(inputId);
        setSkippedFor(inputId, false);
        setDocsByInput((prev) => {
            const byType = prev[inputId] ?? {};
            const current = byType[typeIndex] ?? [];
            const existing = new Set(current.map((doc) => doc.id));
            return {
                ...prev,
                [inputId]: {
                    ...byType,
                    [typeIndex]: [
                        ...current,
                        ...selected.filter((doc) => !existing.has(doc.id)),
                    ],
                },
            };
        });
    };

    const removeDoc = (inputId: string, typeIndex: number, docId: string) => {
        clearConfirmation(inputId);
        setDocsByInput((prev) => {
            const byType = prev[inputId] ?? {};
            return {
                ...prev,
                [inputId]: {
                    ...byType,
                    [typeIndex]: (byType[typeIndex] ?? []).filter(
                        (doc) => doc.id !== docId,
                    ),
                },
            };
        });
    };

    const chooseAnswer = (
        item: Extract<AskInputItem, { kind: "choice" }>,
        answer: string,
    ) => {
        const trimmed = answer.trim();
        if (!trimmed || submitted) return;
        clearConfirmation(item.id);
        setSkippedFor(item.id, false);
        setAnswers((prev) => ({ ...prev, [item.id]: trimmed }));
        setOtherOpen((prev) => ({ ...prev, [item.id]: false }));
    };

    const allResolved =
        event.items.length > 0 && event.items.every(itemResolved);
    const canSubmit = !submitted && allResolved && !!onSubmit;

    const buildResponse = (): AskInputsResponse => {
        const responses = event.items.map((item) => {
            if (skipped.has(item.id)) {
                if (item.kind === "documents") {
                    return {
                        id: item.id,
                        kind: "documents" as const,
                        filenames: [],
                        skipped: true,
                    };
                }
                return {
                    id: item.id,
                    kind: item.kind,
                    question: item.question,
                    skipped: true,
                };
            }
            if (item.kind !== "documents") {
                return {
                    id: item.id,
                    kind: item.kind,
                    question: item.question,
                    answer: answers[item.id]?.trim() ?? "",
                };
            }
            return {
                id: item.id,
                kind: "documents" as const,
                filenames: docsForItem(item.id).map((doc) => doc.filename),
            };
        });
        return { type: "ask_inputs_response", responses };
    };

    const responseFiles = (response: AskInputsResponse) => {
        const responseById = new Map(
            response.responses.map((item) => [item.id, item]),
        );
        const docs = event.items.flatMap((item) => {
            const responseItem = responseById.get(item.id);
            if (
                item.kind !== "documents" ||
                responseItem?.kind !== "documents" ||
                responseItem.skipped
            ) {
                return [];
            }
            return docsForItem(item.id);
        });
        const seen = new Set<string>();
        return docs.flatMap((doc) => {
            if (seen.has(doc.id)) return [];
            seen.add(doc.id);
            return [
                {
                    filename: doc.filename,
                    document_id: doc.id,
                    ...(doc.current_version_id
                        ? { version_id: doc.current_version_id }
                        : {}),
                    ...(doc.active_version_number != null
                        ? { version_number: doc.active_version_number }
                        : {}),
                },
            ];
        });
    };

    const buildContent = (response: AskInputsResponse) => {
        const lines = response.responses.map((item, index) => {
            if (item.kind !== "documents") {
                if (item.skipped)
                    return `${index + 1}. Skipped: ${item.question}`;
                return `${index + 1}. ${item.question}\n${item.answer ?? ""}`;
            }
            if (item.skipped) return `${index + 1}. Skipped document request.`;
            return `${index + 1}. Documents attached: ${item.filenames.join(", ")}`;
        });
        return `Responses to Mike's questions:\n${lines.join("\n\n")}`;
    };

    const submit = () => {
        if (!canSubmit) return;
        const response = buildResponse();
        setSubmitted(true);
        onSubmit?.(response, buildContent(response), responseFiles(response));
    };

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-submit when every question is answered; submit() sets state as part of the side effect
        if (canSubmit) submit();
    });

    const dismiss = useCallback(() => {
        if (submitted || dismissed) return;
        setDismissed(true);
        onDismiss?.();
    }, [dismissed, onDismiss, submitted]);

    useEffect(() => {
        if (submitted || dismissed) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") dismiss();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [submitted, dismissed, dismiss]);

    if (dismissed) return null;

    const activeItem =
        event.items.find((item) => item.id === activeInputId) ?? event.items[0];

    return (
        <>
            <div
                className={`w-full overflow-hidden rounded-[18px] pb-3 font-serif md:rounded-[22px] ${LIQUID_GLASS_TRANSLUCENT_CLASS}`}
            >
                <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
                    <div className="flex min-w-0 items-center">
                        <div className="text-sm text-gray-500">
                            {submitted ? (
                                "Inputs sent"
                            ) : (
                                <div className="flex flex-wrap gap-x-1.5 gap-y-1">
                                    {event.items.map((item) => {
                                        const isActive =
                                            item.id === activeItem?.id;
                                        const isResolved = itemResolved(item);
                                        const label =
                                            item.kind === "documents"
                                                ? "Documents"
                                                : "Question";
                                        return (
                                            <TabPillButton
                                                key={item.id}
                                                active={isActive}
                                                disabled={submitted}
                                                onClick={() =>
                                                    setActiveInputId(item.id)
                                                }
                                                className="h-6 px-2 font-sans text-[10px]"
                                            >
                                                {isResolved ? (
                                                    <Check className="h-3 w-3" />
                                                ) : (
                                                    <span className="h-2.5 w-2.5 rounded-full border border-current opacity-70" />
                                                )}
                                                {label}
                                            </TabPillButton>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                    {!submitted && (
                        <TabPillButton
                            type="button"
                            onClick={dismiss}
                            aria-label="Dismiss"
                            className="h-6 w-6 shrink-0 px-0"
                        >
                            <X className="h-3 w-3" />
                        </TabPillButton>
                    )}
                </div>

                <div className="px-3">
                    {activeItem && (
                        <div className="mt-3 flex min-h-54 flex-col">
                            <div>
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        {activeItem.kind !== "documents" ? (
                                            <p className="text-sm text-gray-800">
                                                {activeItem.question}
                                            </p>
                                        ) : (
                                            <DocumentPrompt />
                                        )}
                                    </div>
                                </div>

                                <div className="pt-3">
                                    {activeItem.kind === "choice" ? (
                                        <OptionInput
                                            item={activeItem}
                                            disabled={
                                                submitted ||
                                                skipped.has(activeItem.id)
                                            }
                                            selectedAnswer={
                                                answers[activeItem.id] ?? null
                                            }
                                            otherOpen={
                                                !!otherOpen[activeItem.id]
                                            }
                                            otherValue={
                                                otherValues[activeItem.id] ?? ""
                                            }
                                            onAnswer={(answer) =>
                                                chooseAnswer(activeItem, answer)
                                            }
                                            onOtherOpen={() => {
                                                clearConfirmation(
                                                    activeItem.id,
                                                );
                                                setOtherOpen((prev) => ({
                                                    ...prev,
                                                    [activeItem.id]: true,
                                                }));
                                                setAnswers((prev) => ({
                                                    ...prev,
                                                    [activeItem.id]: (
                                                        otherValues[
                                                            activeItem.id
                                                        ] ?? ""
                                                    ).trim(),
                                                }));
                                            }}
                                            onOtherValue={(value) => {
                                                clearConfirmation(
                                                    activeItem.id,
                                                );
                                                setOtherValues((prev) => ({
                                                    ...prev,
                                                    [activeItem.id]: value,
                                                }));
                                                setAnswers((prev) => ({
                                                    ...prev,
                                                    [activeItem.id]:
                                                        value.trim(),
                                                }));
                                                if (value.trim())
                                                    setSkippedFor(
                                                        activeItem.id,
                                                        false,
                                                    );
                                            }}
                                        />
                                    ) : activeItem.kind === "text" ? (
                                        <OpenTextInput
                                            item={activeItem}
                                            value={answers[activeItem.id] ?? ""}
                                            disabled={
                                                submitted ||
                                                skipped.has(activeItem.id)
                                            }
                                            onChange={(value) => {
                                                clearConfirmation(
                                                    activeItem.id,
                                                );
                                                setAnswers((prev) => ({
                                                    ...prev,
                                                    [activeItem.id]: value,
                                                }));
                                                if (value.trim()) {
                                                    setSkippedFor(
                                                        activeItem.id,
                                                        false,
                                                    );
                                                }
                                            }}
                                        />
                                    ) : (
                                        <DocumentInput
                                            item={activeItem}
                                            disabled={
                                                submitted ||
                                                skipped.has(activeItem.id)
                                            }
                                            docsByType={
                                                docsByInput[activeItem.id] ?? {}
                                            }
                                            onOpenSelector={(typeIndex) =>
                                                setDocSelectorTarget({
                                                    inputId: activeItem.id,
                                                    typeIndex,
                                                })
                                            }
                                            onRemoveDoc={(typeIndex, docId) =>
                                                removeDoc(
                                                    activeItem.id,
                                                    typeIndex,
                                                    docId,
                                                )
                                            }
                                        />
                                    )}
                                </div>
                            </div>
                            {!submitted && (
                                <div className="mt-auto flex items-center justify-end gap-2 pt-3">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setSkippedFor(
                                                activeItem.id,
                                                !skipped.has(activeItem.id),
                                            )
                                        }
                                        className="px-1 font-sans text-[10px] text-gray-500 transition-colors hover:text-gray-800"
                                    >
                                        {skipped.has(activeItem.id)
                                            ? "Unskip"
                                            : "Skip"}
                                    </button>
                                    <PillButton
                                        tone="black"
                                        type="button"
                                        disabled={
                                            skipped.has(activeItem.id) ||
                                            confirmed.has(activeItem.id) ||
                                            !itemAnswered(activeItem)
                                        }
                                        onClick={() =>
                                            confirmItem(activeItem.id)
                                        }
                                        className="h-6 px-3 font-sans text-[10px]"
                                    >
                                        {confirmed.has(activeItem.id) ? (
                                            <>
                                                Confirmed
                                                <Check className="h-3 w-3" />
                                            </>
                                        ) : (
                                            "Confirm"
                                        )}
                                    </PillButton>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <AddDocumentsModal
                open={!!docSelectorTarget}
                keepMounted
                onClose={() => setDocSelectorTarget(null)}
                onSelect={(selected) => {
                    if (!docSelectorTarget) return;
                    // A document can only be added once per input, so docs
                    // already living in another type row are left where they
                    // are; only genuinely new picks join the targeted row.
                    const existing = new Set(
                        docsForItem(docSelectorTarget.inputId).map(
                            (doc) => doc.id,
                        ),
                    );
                    addDocs(
                        docSelectorTarget.inputId,
                        docSelectorTarget.typeIndex,
                        selected.filter((doc) => !existing.has(doc.id)),
                    );
                }}
                breadcrumb={["Assistant", "Add Documents"]}
                uploadStateId="assistant-ask-input"
                initialSelectedDocuments={
                    docSelectorTarget
                        ? docsForItem(docSelectorTarget.inputId)
                        : []
                }
            />
        </>
    );
}

function OpenTextInput({
    item,
    value,
    disabled,
    onChange,
}: {
    item: Extract<AskInputItem, { kind: "text" }>;
    value: string;
    disabled?: boolean;
    onChange: (value: string) => void;
}) {
    return (
        <div className="mt-2">
            <textarea
                name={`answer-${item.id}`}
                aria-label={item.question}
                aria-describedby={`answer-${item.id}-limit`}
                rows={5}
                maxLength={OPEN_TEXT_MAX_LENGTH}
                value={value}
                disabled={disabled}
                onChange={(event) =>
                    onChange(event.target.value.slice(0, OPEN_TEXT_MAX_LENGTH))
                }
                placeholder="Type your answer..."
                className="min-h-28 w-full resize-y rounded-lg bg-gray-100/70 px-3 py-2 text-sm leading-5 text-gray-700 outline-none transition-colors placeholder:text-gray-400 focus:bg-gray-200/70 disabled:cursor-default disabled:opacity-60"
            />
            <p
                id={`answer-${item.id}-limit`}
                className="mt-1 text-right font-sans text-[10px] text-gray-400"
            >
                {value.length.toLocaleString()} /{" "}
                {OPEN_TEXT_MAX_LENGTH.toLocaleString()}
            </p>
        </div>
    );
}

function OptionInput({
    item,
    disabled,
    selectedAnswer,
    otherOpen,
    otherValue,
    onAnswer,
    onOtherOpen,
    onOtherValue,
}: {
    item: Extract<AskInputItem, { kind: "choice" }>;
    disabled?: boolean;
    selectedAnswer: string | null;
    otherOpen: boolean;
    otherValue: string;
    onAnswer: (answer: string) => void;
    onOtherOpen: () => void;
    onOtherValue: (value: string) => void;
}) {
    return (
        <div className="mt-2 grid gap-1.5">
            {item.options.map((option, idx) => {
                const answer = option.value.trim();
                const isSelected = !otherOpen && selectedAnswer === answer;
                return (
                    <button
                        key={`${item.id}-${option.value}-${idx}`}
                        type="button"
                        disabled={disabled}
                        onClick={() => onAnswer(answer)}
                        className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                            isSelected
                                ? "bg-gray-200/80 text-gray-900"
                                : "bg-gray-100/70 text-gray-700 hover:bg-gray-200/70 disabled:hover:bg-gray-100/70"
                        } disabled:cursor-default disabled:opacity-60`}
                    >
                        <span className="flex items-start gap-1">
                            <span className="mt-0.5 w-4 shrink-0 text-xs text-gray-500">
                                {idx + 1}.
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm">{answer}</span>
                            </span>
                            {isSelected && (
                                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-700" />
                            )}
                        </span>
                    </button>
                );
            })}
            {item.allow_other && (
                <div
                    className={`w-full rounded-lg px-3 py-2 transition-colors ${
                        otherOpen
                            ? "bg-gray-200/80"
                            : "cursor-pointer bg-gray-100/70 hover:bg-gray-200/70"
                    } ${disabled ? "cursor-default opacity-60" : ""}`}
                    onClick={() => !otherOpen && !disabled && onOtherOpen()}
                >
                    <span className="flex items-start gap-1">
                        <span className="mt-0.5 w-4 shrink-0 text-xs text-gray-500">
                            {item.options.length + 1}.
                        </span>
                        {otherOpen ? (
                            <span className="min-w-0 flex-1 flex items-start gap-2">
                                <textarea
                                    name={`other-${item.id}`}
                                    rows={1}
                                    autoFocus
                                    value={otherValue}
                                    disabled={disabled}
                                    onFocus={(e) => {
                                        const end = e.target.value.length;
                                        e.target.setSelectionRange(end, end);
                                        e.target.style.height = "auto";
                                        e.target.style.height = `${e.target.scrollHeight}px`;
                                    }}
                                    onChange={(e) => {
                                        onOtherValue(e.target.value);
                                        e.target.style.height = "auto";
                                        e.target.style.height = `${e.target.scrollHeight}px`;
                                    }}
                                    placeholder="Type your answer..."
                                    className="flex-1 resize-none overflow-hidden bg-transparent text-sm leading-5 text-gray-600 outline-none placeholder:text-gray-400"
                                />
                            </span>
                        ) : (
                            <span className="min-w-0 flex-1 text-sm text-gray-700">
                                {item.other_label || "Other"}
                            </span>
                        )}
                        {otherOpen && (
                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-700" />
                        )}
                    </span>
                </div>
            )}
        </div>
    );
}

function DocumentPrompt() {
    return (
        <p className="mt-0.5 text-sm text-gray-800">
            Add the following documents if available:
        </p>
    );
}

function DocumentInput({
    item,
    disabled,
    docsByType,
    onOpenSelector,
    onRemoveDoc,
}: {
    item: Extract<AskInputItem, { kind: "documents" }>;
    disabled?: boolean;
    docsByType: Record<number, Document[]>;
    onOpenSelector: (typeIndex: number) => void;
    onRemoveDoc: (typeIndex: number, docId: string) => void;
}) {
    const documentTypes = item.document_types ?? [];
    const rows = documentTypes.length > 0 ? documentTypes : ["Documents"];
    return (
        <div className="mt-2 grid gap-1.5">
            {rows.map((documentType, idx) => {
                const docs = docsByType[idx] ?? [];
                return (
                    <div
                        key={`${item.id}-${documentType}-${idx}`}
                        role="button"
                        tabIndex={disabled ? -1 : 0}
                        aria-disabled={disabled}
                        onClick={() => !disabled && onOpenSelector(idx)}
                        onKeyDown={(e) => {
                            if (
                                !disabled &&
                                (e.key === "Enter" || e.key === " ")
                            ) {
                                e.preventDefault();
                                onOpenSelector(idx);
                            }
                        }}
                        className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                            docs.length > 0
                                ? "bg-gray-200/80 text-gray-900"
                                : "bg-gray-100/70 text-gray-700"
                        } ${
                            disabled
                                ? "cursor-default opacity-60"
                                : "cursor-pointer hover:bg-gray-200/70"
                        }`}
                    >
                        <span className="flex items-start gap-1">
                            <span className="mt-0.5 w-4 shrink-0 text-xs text-gray-500">
                                {idx + 1}.
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block break-words text-sm">
                                    {documentType}
                                </span>
                                {docs.length > 0 && (
                                    <span className="mt-1.5 flex flex-wrap gap-1.5">
                                        {docs.map((doc) => (
                                            <span
                                                key={`${item.id}-${doc.id}`}
                                                onClick={(e) =>
                                                    e.stopPropagation()
                                                }
                                                className={`inline-flex items-center gap-1 rounded-[10px] py-0.5 pl-2 pr-1 text-xs text-gray-800 ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl`}
                                            >
                                                <FileTypeIcon
                                                    fileType={doc.file_type}
                                                    className="h-2.5 w-2.5"
                                                />
                                                <span className="max-w-[160px] truncate">
                                                    {doc.filename}
                                                </span>
                                                {!disabled && (
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onRemoveDoc(
                                                                idx,
                                                                doc.id,
                                                            );
                                                        }}
                                                        className="ml-0.5 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-gray-900/5 hover:text-gray-700"
                                                    >
                                                        <X className="h-2.5 w-2.5" />
                                                    </button>
                                                )}
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </span>
                            <span className="mt-0.5 shrink-0 whitespace-nowrap font-sans text-[10px] text-gray-500">
                                {docs.length > 0
                                    ? `${docs.length} file${docs.length === 1 ? "" : "s"} added`
                                    : "+ Add"}
                            </span>
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

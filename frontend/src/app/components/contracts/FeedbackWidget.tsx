"use client";

import { useState } from "react";
import { Check, Edit3, Save, X } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { useDraftFeedback } from "@/app/hooks/useDraftFeedback";
import { postContractFeedback } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { ReviewFeedbackRow } from "./reviewTypes";

// The four Janus feedback variants, labels verbatim. One review_feedback row per
// save; the parent receives the row and hides the widget behind a status pill
// (Janus re-showed the buttons after reload — fixed here on purpose).
export type FeedbackVariant = "validate" | "revise" | "answer" | "add-skip";

export const FEEDBACK_BADGE: Record<string, string> = {
    valid: "Dikonfirmasi",
    accept: "Diterima",
    edit: "Diubah COO",
    reject: "Ditolak",
    dismiss: "Diabaikan",
    answered: "Terjawab",
    skip: "Dilewati",
    override: "Dikoreksi",
    adjust: "Disesuaikan",
};

export function feedbackBadgeLabel(fb: ReviewFeedbackRow): string {
    if (fb.action === "adjust" && fb.adjusted_severity) {
        return `${fb.original_severity ?? "?"} → ${fb.adjusted_severity}`;
    }
    return FEEDBACK_BADGE[fb.action] ?? fb.action;
}

export function FeedbackRecorded({ feedback }: { feedback?: ReviewFeedbackRow | null }) {
    return (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                <Check className="h-3.5 w-3.5" /> Umpan balik tercatat
            </span>
            {feedback ? (
                <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600">
                    {feedbackBadgeLabel(feedback)}
                </span>
            ) : null}
            {feedback?.rationale ? (
                <span className="w-full text-xs text-gray-500">
                    {feedback.action === "answered" ? "Jawaban: " : "Alasan: "}
                    {feedback.rationale}
                </span>
            ) : null}
        </div>
    );
}

function renderActionButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
    return (
        <PillButtonUI tone="white" size="xs" onClick={onClick} disabled={disabled}>
            {children}
        </PillButtonUI>
    );
}

function renderSaveButton({ onClick, disabled, label = "Simpan", saving }: { onClick: () => void; disabled?: boolean; label?: string; saving: boolean }) {
    return (
        <PillButtonUI tone="black" size="xs" onClick={onClick} disabled={disabled} loading={saving}>
            <Save className="mr-1 h-3 w-3" /> {label}
        </PillButtonUI>
    );
}

function renderCancelButton(onClick: () => void) {
    return (
        <button type="button" onClick={onClick} className="text-xs text-gray-500 hover:text-gray-800">
            Batalkan
        </button>
    );
}

const TEXTAREA_CLASS =
    "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400";

function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return <textarea {...props} className={TEXTAREA_CLASS} />;
}

interface FeedbackWidgetProps {
    reviewId: string;
    findingType: string;
    findingId: string;
    variant?: FeedbackVariant;
    originalSeverity?: string | null;
    originalText?: string | null;
    existing?: ReviewFeedbackRow | null;
    onSaved: (row: ReviewFeedbackRow) => void;
}

export function FeedbackWidget({
    reviewId,
    findingType,
    findingId,
    variant = "validate",
    originalSeverity,
    originalText,
    existing,
    onSaved,
}: FeedbackWidgetProps) {
    const { draft, setDraft, clearDraft } = useDraftFeedback(reviewId, findingId, originalText ?? "");
    const { action, rationale, adjustedSeverity, editedText } = draft;
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (existing) return <FeedbackRecorded feedback={existing} />;

    const save = async (selectedAction: string) => {
        setSaving(true);
        setError(null);
        try {
            const row = await postContractFeedback(reviewId, {
                finding_type: findingType,
                finding_id: findingId,
                action: selectedAction,
                original_severity: originalSeverity ?? null,
                adjusted_severity: adjustedSeverity || null,
                original_text: originalText ?? null,
                edited_text: selectedAction === "edit" ? editedText : null,
                rationale: rationale || null,
            });
            clearDraft();
            onSaved(row);
        } catch (e) {
            setError(userFacingApiError(e, "Umpan balik gagal disimpan."));
        } finally {
            setSaving(false);
        }
    };

    const cancel = () => setDraft({ action: null });
    const Btn = ({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) =>
        renderActionButton({ children, onClick, disabled: disabled || saving });
    const SaveBtn = ({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label?: string }) =>
        renderSaveButton({ onClick, disabled, label, saving });
    const CancelBtn = () => renderCancelButton(cancel);

    let body: React.ReactNode;
    if (variant === "validate") {
        body = !action ? (
            <div className="flex flex-wrap gap-2">
                {Btn({ onClick: () => save("valid"), children: <><Check className="mr-1 h-3 w-3" /> Valid</> })}
                {Btn({ onClick: () => setDraft({ action: "adjust" }), children: <><Edit3 className="mr-1 h-3 w-3" /> Sesuaikan</> })}
                {Btn({ onClick: () => setDraft({ action: "dismiss" }), children: <><X className="mr-1 h-3 w-3" /> Abaikan</> })}
            </div>
        ) : (
            <div className="space-y-2">
                {action === "adjust" ? (
                    <select
                        aria-label="Severity baru"
                        value={adjustedSeverity}
                        onChange={(e) => setDraft({ adjustedSeverity: e.target.value })}
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                    >
                        <option value="">Severity baru</option>
                        <option value="CRITICAL">Critical</option>
                        <option value="HIGH">High</option>
                        <option value="MEDIUM">Medium</option>
                        <option value="LOW">Low</option>
                    </select>
                ) : null}
                <Textarea value={rationale} onChange={(e) => setDraft({ rationale: e.target.value })} placeholder="Tambahkan alasan..." rows={2} />
                <div className="flex items-center gap-3">
                    {SaveBtn({ onClick: () => save(action), disabled: action === "dismiss" && !rationale.trim() })}
                    {CancelBtn()}
                </div>
            </div>
        );
    } else if (variant === "revise") {
        body = !action ? (
            <div className="flex flex-wrap gap-2">
                {Btn({ onClick: () => save("accept"), children: <><Check className="mr-1 h-3 w-3" /> Terima</> })}
                {Btn({ onClick: () => setDraft({ action: "edit" }), children: <><Edit3 className="mr-1 h-3 w-3" /> Ubah</> })}
                {Btn({ onClick: () => setDraft({ action: "reject" }), children: <><X className="mr-1 h-3 w-3" /> Tolak</> })}
            </div>
        ) : action === "edit" ? (
            <div className="space-y-2">
                <Textarea aria-label="Teks revisi" value={editedText} onChange={(e) => setDraft({ editedText: e.target.value })} rows={3} />
                <div className="flex items-center gap-3">
                    {SaveBtn({ onClick: () => save("edit"), disabled: !editedText.trim() })}
                    {CancelBtn()}
                </div>
            </div>
        ) : (
            <div className="space-y-2">
                <Textarea value={rationale} onChange={(e) => setDraft({ rationale: e.target.value })} placeholder="Alasan penolakan..." rows={2} />
                <div className="flex items-center gap-3">
                    {SaveBtn({ onClick: () => save("reject"), disabled: !rationale.trim() })}
                    {CancelBtn()}
                </div>
            </div>
        );
    } else if (variant === "answer") {
        body = (
            <div className="space-y-2">
                <Textarea value={rationale} onChange={(e) => setDraft({ rationale: e.target.value })} placeholder="Jawaban Anda..." rows={2} />
                {SaveBtn({ onClick: () => save("answered"), disabled: !rationale.trim(), label: "Tandai Terjawab" })}
            </div>
        );
    } else {
        body = !action ? (
            <div className="flex flex-wrap gap-2">
                {Btn({ onClick: () => save("accept"), children: <><Check className="mr-1 h-3 w-3" /> Tambah</> })}
                {Btn({ onClick: () => setDraft({ action: "skip" }), children: <><X className="mr-1 h-3 w-3" /> Lewati</> })}
            </div>
        ) : (
            <div className="space-y-2">
                <Textarea value={rationale} onChange={(e) => setDraft({ rationale: e.target.value })} placeholder="Alasan melewati..." rows={2} />
                <div className="flex items-center gap-3">
                    {SaveBtn({ onClick: () => save("skip"), disabled: !rationale.trim() })}
                    {CancelBtn()}
                </div>
            </div>
        );
    }

    return (
        <div className="mt-3 space-y-2 border-t border-gray-100 pt-2.5">
            {body}
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
    );
}

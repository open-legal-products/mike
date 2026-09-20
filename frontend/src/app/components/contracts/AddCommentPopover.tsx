"use client";

import { useEffect, useState } from "react";
import { AlertOctagon, MessageSquare } from "lucide-react";
import { postContractComment, postContractMissedClause, type ContractCommentInput, type ContractMissedClauseInput } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import type { ManualCommentRow } from "./reviewTypes";

// Selection popover (Janus AddCommentPopover). Four comment types write a
// manual_comments row; "AI melewatkan klausul ini" is a training signal that
// goes to missed_clause_feedback instead and never shows up as a comment.

type CommentType = ContractCommentInput["comment_type"] | "ai_missed";
type MissedCategory = ContractMissedClauseInput["suggested_category"];

const COMMENT_TYPES: { value: CommentType; label: string }[] = [
    { value: "note", label: "Catatan" },
    { value: "revision_suggestion", label: "Saran Revisi" },
    { value: "question", label: "Pertanyaan" },
    { value: "red_flag", label: "Tanda Bahaya" },
    { value: "ai_missed", label: "AI melewatkan klausul ini" },
];

const MISSED_CATEGORIES: { value: MissedCategory; label: string }[] = [
    { value: "red_flag", label: "Tanda Bahaya" },
    { value: "revision", label: "Saran Revisi" },
    { value: "clarification", label: "Klarifikasi" },
    { value: "missing_clause", label: "Klausul yang Hilang" },
    { value: "yellow_flag", label: "Peringatan" },
];

export interface SelectionAnchor {
    text: string;
    start: number;
    end: number;
    position: { top: number; left: number };
}

export interface AddCommentPopoverProps {
    reviewId: string;
    anchor: SelectionAnchor;
    onClose: () => void;
    onCommentSaved: (row: ManualCommentRow) => void;
    onSignalSaved: () => void;
}

export function AddCommentPopover({ reviewId, anchor, onClose, onCommentSaved, onSignalSaved }: AddCommentPopoverProps) {
    const [type, setType] = useState<CommentType>("note");
    const [text, setText] = useState("");
    const [suggested, setSuggested] = useState("");
    const [category, setCategory] = useState<MissedCategory>("red_flag");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isMissed = type === "ai_missed";

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const save = async () => {
        const note = text.trim();
        if (!note) return;
        setBusy(true);
        setError(null);
        const offsets = anchor.start >= 0 ? { highlight_start: anchor.start, highlight_end: anchor.end } : { highlight_start: null, highlight_end: null };
        try {
            if (isMissed) {
                await postContractMissedClause(reviewId, { highlight_text: anchor.text, suggested_category: category, user_note: note, ...offsets });
                onSignalSaved();
            } else {
                const row = await postContractComment(reviewId, {
                    comment_type: type,
                    comment_text: note,
                    highlight_text: anchor.text,
                    suggested_text: type === "revision_suggestion" ? suggested.trim() || null : null,
                    ...offsets,
                });
                onCommentSaved(row);
            }
            onClose();
        } catch (e) {
            setError(userFacingApiError(e, "Gagal menyimpan."));
        } finally {
            setBusy(false);
        }
    };

    const selectClass = "h-8 w-full rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-800 focus:border-gray-400 focus:outline-none";

    return (
        <div
            role="dialog"
            aria-label={isMissed ? "Tandai sebagai dilewati AI" : "Tambah Komentar"}
            className="fixed z-50 w-80 space-y-2.5 rounded-xl border border-gray-200 bg-white p-4 text-sm shadow-xl"
            style={{ top: anchor.position.top, left: anchor.position.left }}
        >
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700">
                {isMissed ? <AlertOctagon className="h-3.5 w-3.5 text-amber-600" /> : <MessageSquare className="h-3.5 w-3.5 text-gray-500" />}
                {isMissed ? "Tandai sebagai dilewati AI" : "Tambah Komentar"}
            </div>
            <blockquote className="max-h-16 overflow-hidden rounded bg-gray-50 p-2 text-xs italic text-gray-600">
                “{anchor.text.slice(0, 100)}{anchor.text.length > 100 ? "..." : ""}”
            </blockquote>
            <select aria-label="Jenis komentar" value={type} onChange={(e) => setType(e.target.value as CommentType)} className={selectClass}>
                {COMMENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                ))}
            </select>
            {isMissed ? (
                <label className="block space-y-1">
                    <span className="text-[11px] uppercase tracking-wide text-gray-500">Seharusnya AI tandai sebagai</span>
                    <select aria-label="Kategori yang seharusnya" value={category} onChange={(e) => setCategory(e.target.value as MissedCategory)} className={selectClass}>
                        {MISSED_CATEGORIES.map((c) => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                    </select>
                </label>
            ) : null}
            <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={2}
                aria-label={isMissed ? "Alasan" : "Komentar"}
                placeholder={isMissed ? "Mengapa AI seharusnya menandai ini?" : "Tulis komentar..."}
                className="w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-gray-400 focus:outline-none"
            />
            {type === "revision_suggestion" ? (
                <textarea
                    value={suggested}
                    onChange={(e) => setSuggested(e.target.value)}
                    rows={2}
                    aria-label="Teks yang disarankan"
                    placeholder="Teks yang disarankan..."
                    className="w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-gray-400 focus:outline-none"
                />
            ) : null}
            <div className="flex items-center gap-2">
                <PillButtonUI tone="black" size="xs" onClick={() => void save()} loading={busy} disabled={busy || !text.trim()}>
                    {isMissed ? "Simpan sinyal" : "Simpan"}
                </PillButtonUI>
                <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800">Batal</button>
                {error ? <span className="text-xs text-red-600">{error}</span> : null}
            </div>
        </div>
    );
}

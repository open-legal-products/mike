"use client";

import { useState } from "react";
import { Check, Edit3, FileDiff, Save, X } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { resolveContractRevision } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { ReviewFeedbackRow, Revision, RevisionEditRow } from "./reviewTypes";
import { FeedbackRecorded, FeedbackWidget } from "./FeedbackWidget";

// A revision that was projected into the DOCX as a tracked change: Terima /
// Tolak / Ubah rewrite the document AND record the Janus feedback row. When the
// projection failed (or there is no DOCX) the card falls back to the plain
// FeedbackWidget, exactly as before.

export interface RevisionCardActionsProps {
    reviewId: string;
    revision: Revision;
    edit: RevisionEditRow | null;
    existing: ReviewFeedbackRow | null;
    onResolved: (edit: RevisionEditRow, feedback: ReviewFeedbackRow) => void;
    onFeedbackSaved: (row: ReviewFeedbackRow) => void;
}

const TEXTAREA_CLASS =
    "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400";

export function RevisionCardActions({ reviewId, revision, edit, existing, onResolved, onFeedbackSaved }: RevisionCardActionsProps) {
    const tracked = Boolean(edit && edit.change_id && !edit.error);
    const [mode, setMode] = useState<"idle" | "edit" | "reject">("idle");
    const [editedText, setEditedText] = useState(revision.suggested_text);
    const [rationale, setRationale] = useState("");
    const [busy, setBusy] = useState<"accept" | "reject" | "edit" | null>(null);
    const [error, setError] = useState<string | null>(null);

    if (!tracked) {
        return (
            <>
                {edit?.error ? (
                    <p className="mt-2 text-xs text-amber-700">
                        Tidak dapat dipetakan ke dokumen ({edit.error}). Umpan balik tetap tercatat tanpa perubahan terlacak.
                    </p>
                ) : null}
                <FeedbackWidget
                    reviewId={reviewId}
                    findingType="revision"
                    findingId={revision.id}
                    variant="revise"
                    originalText={revision.suggested_text}
                    existing={existing}
                    onSaved={onFeedbackSaved}
                />
            </>
        );
    }

    if (existing || edit!.status !== "pending") {
        return (
            <div>
                <FeedbackRecorded feedback={existing} />
                <p className="mt-1 inline-flex items-center gap-1 text-xs text-gray-500">
                    <FileDiff className="h-3 w-3" />
                    {edit!.status === "accepted" ? "Perubahan diterapkan di dokumen" : "Perubahan ditolak di dokumen"}
                    {edit!.author ? ` · ${edit!.author}` : ""}
                </p>
            </div>
        );
    }

    const run = async (verb: "accept" | "reject" | "edit") => {
        setBusy(verb);
        setError(null);
        try {
            const result = await resolveContractRevision(reviewId, revision.id, verb, {
                rationale: verb === "reject" ? rationale : undefined,
                edited_text: verb === "edit" ? editedText : undefined,
            });
            onResolved(result.edit, result.feedback);
        } catch (e) {
            setError(userFacingApiError(e, "Perubahan gagal diterapkan ke dokumen."));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="mt-3 space-y-2 border-t border-gray-100 pt-2.5">
            <p className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                <FileDiff className="h-3 w-3" /> Perubahan terlacak di dokumen
            </p>
            {mode === "idle" ? (
                <div className="flex flex-wrap gap-2">
                    <PillButtonUI tone="white" size="xs" onClick={() => run("accept")} loading={busy === "accept"} disabled={busy !== null}>
                        <Check className="mr-1 h-3 w-3" /> Terima
                    </PillButtonUI>
                    <PillButtonUI tone="white" size="xs" onClick={() => setMode("edit")} disabled={busy !== null}>
                        <Edit3 className="mr-1 h-3 w-3" /> Ubah
                    </PillButtonUI>
                    <PillButtonUI tone="white" size="xs" onClick={() => setMode("reject")} disabled={busy !== null}>
                        <X className="mr-1 h-3 w-3" /> Tolak
                    </PillButtonUI>
                </div>
            ) : mode === "edit" ? (
                <div className="space-y-2">
                    <textarea aria-label="Teks revisi" value={editedText} onChange={(e) => setEditedText(e.target.value)} rows={3} className={TEXTAREA_CLASS} />
                    <div className="flex items-center gap-3">
                        <PillButtonUI tone="black" size="xs" onClick={() => run("edit")} disabled={!editedText.trim()} loading={busy === "edit"}>
                            <Save className="mr-1 h-3 w-3" /> Simpan
                        </PillButtonUI>
                        <button type="button" onClick={() => setMode("idle")} className="text-xs text-gray-500 hover:text-gray-800">Batalkan</button>
                    </div>
                </div>
            ) : (
                <div className="space-y-2">
                    <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Alasan penolakan..." rows={2} className={TEXTAREA_CLASS} />
                    <div className="flex items-center gap-3">
                        <PillButtonUI tone="black" size="xs" onClick={() => run("reject")} disabled={!rationale.trim()} loading={busy === "reject"}>
                            <Save className="mr-1 h-3 w-3" /> Simpan
                        </PillButtonUI>
                        <button type="button" onClick={() => setMode("idle")} className="text-xs text-gray-500 hover:text-gray-800">Batalkan</button>
                    </div>
                </div>
            )}
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
    );
}

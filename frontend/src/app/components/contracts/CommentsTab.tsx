"use client";

import { useMemo, useState } from "react";
import { MessageSquare, Quote, User } from "lucide-react";
import { postContractComment } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { COMMENT_TYPE_LABEL, groupReplies, locateQuote } from "./findingAnnotations";
import type { ManualCommentRow } from "./reviewTypes";

// Komentar tab: the manual annotations Janus showed beside the document on
// "Tinjauan AI". Root comments are ordered by their anchor in the contract;
// replies (parent_comment_id) nest under their parent. New comments come from
// selecting text in the document pane (AddCommentPopover).

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
    } catch {
        return iso;
    }
}

export interface CommentsTabProps {
    reviewId: string;
    comments: ManualCommentRow[];
    contractText: string | null;
    onLocate: (text: string) => void;
    onCommentSaved: (row: ManualCommentRow) => void;
}

export function CommentsTab({ reviewId, comments, contractText, onLocate, onCommentSaved }: CommentsTabProps) {
    const roots = useMemo(() => {
        const list = comments.filter((c) => !c.parent_comment_id).map((c) => ({ c, pos: locateQuote(contractText, c.highlight_text) }));
        list.sort((a, b) => {
            if (a.pos === -1 && b.pos === -1) return a.c.created_at.localeCompare(b.c.created_at);
            if (a.pos === -1) return 1;
            if (b.pos === -1) return -1;
            return a.pos - b.pos;
        });
        return list.map((x) => x.c);
    }, [comments, contractText]);
    const replies = useMemo(() => groupReplies(comments), [comments]);

    return (
        <div className="space-y-3 text-sm">
            <p className="rounded-xl border border-dashed border-gray-300 bg-white px-3 py-2 text-xs text-gray-500">
                Sorot teks pada dokumen untuk menambahkan komentar, saran revisi, pertanyaan, atau menandai klausul yang dilewati AI.
            </p>
            {roots.length === 0 ? (
                <p className="py-10 text-center text-xs text-gray-500">Belum ada komentar.</p>
            ) : (
                roots.map((c) => (
                    <CommentCard key={c.id} reviewId={reviewId} comment={c} replies={replies.get(c.id) ?? []} onLocate={onLocate} onCommentSaved={onCommentSaved} />
                ))
            )}
        </div>
    );
}

function CommentCard({
    reviewId,
    comment,
    replies,
    onLocate,
    onCommentSaved,
}: {
    reviewId: string;
    comment: ManualCommentRow;
    replies: ManualCommentRow[];
    onLocate: (text: string) => void;
    onCommentSaved: (row: ManualCommentRow) => void;
}) {
    const [replying, setReplying] = useState(false);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const canLocate = (comment.highlight_text?.length ?? 0) >= 5;

    const sendReply = async () => {
        if (!text.trim()) return;
        setBusy(true);
        setError(null);
        try {
            const row = await postContractComment(reviewId, { comment_type: "note", comment_text: text.trim(), parent_comment_id: comment.id });
            onCommentSaved(row);
            setText("");
            setReplying(false);
        } catch (e) {
            setError(userFacingApiError(e, "Balasan gagal disimpan."));
        } finally {
            setBusy(false);
        }
    };

    return (
        <article data-testid={`comment-${comment.id}`} className="rounded-xl border border-gray-200 border-l-[3px] border-l-purple-400 bg-white p-3.5">
            <header className="flex items-center justify-between gap-2 text-[11.5px] text-gray-500">
                <span className="inline-flex items-center gap-1 font-medium text-gray-800">
                    <User className="h-3 w-3" /> {comment.user_name ?? "User"}
                </span>
                <span className="tabular-nums">{formatDate(comment.created_at)}</span>
            </header>
            <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600">{COMMENT_TYPE_LABEL[comment.comment_type] ?? comment.comment_type}</span>
                {canLocate ? (
                    <button type="button" onClick={() => onLocate(comment.highlight_text as string)} className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:underline">
                        <Quote className="h-3 w-3" /> Lihat di dokumen
                    </button>
                ) : null}
            </div>
            {comment.highlight_text ? (
                <blockquote className="mt-2 line-clamp-3 border-l-2 border-gray-200 pl-2 text-xs italic text-gray-500">{comment.highlight_text}</blockquote>
            ) : null}
            <p className="mt-2 leading-6 text-gray-800">{comment.comment_text}</p>
            {comment.suggested_text ? (
                <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 p-2.5 text-xs leading-5 text-blue-800">
                    <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-blue-500">Teks yang disarankan</span>
                    <p className="mt-1 font-serif">{comment.suggested_text}</p>
                </div>
            ) : null}

            {replies.length > 0 ? (
                <ul className="mt-3 space-y-2 border-l-2 border-gray-100 pl-3">
                    {replies.map((r) => (
                        <li key={r.id} className="text-sm">
                            <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                <span className="inline-flex items-center gap-1 font-medium text-gray-700">
                                    <User className="h-3 w-3" /> {r.user_name ?? "User"}
                                </span>
                                <span>{formatDate(r.created_at)}</span>
                            </div>
                            <p className="text-gray-800">{r.comment_text}</p>
                        </li>
                    ))}
                </ul>
            ) : null}

            <div className="mt-3">
                {replying ? (
                    <div className="space-y-2">
                        <textarea
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            rows={2}
                            placeholder="Tulis balasan..."
                            aria-label="Balasan"
                            className="w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-gray-400 focus:outline-none"
                        />
                        <div className="flex items-center gap-2">
                            <PillButtonUI tone="black" size="xs" onClick={() => void sendReply()} loading={busy} disabled={busy || !text.trim()}>
                                Kirim
                            </PillButtonUI>
                            <button type="button" onClick={() => { setReplying(false); setText(""); }} className="text-xs text-gray-500 hover:text-gray-800">
                                Batal
                            </button>
                            {error ? <span className="text-xs text-red-600">{error}</span> : null}
                        </div>
                    </div>
                ) : (
                    <button type="button" onClick={() => setReplying(true)} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
                        <MessageSquare className="h-3 w-3" /> Balas
                    </button>
                )}
            </div>
        </article>
    );
}

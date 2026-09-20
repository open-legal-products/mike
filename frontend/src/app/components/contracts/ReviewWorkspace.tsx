"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { Download, FileDiff } from "lucide-react";
import { MikeApiError, generateContractMemo, getContract, getContractDownloadUrl, patchContract, projectContractRedline, type ContractPatch } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ContractDocument } from "./ContractDocument";
import { DraftFindings } from "./DraftFindings";
import { StatusPill } from "./StatusPill";
import { NegotiationTab } from "./NegotiationTab";
import type { ContractReviewDetail, NegotiationPointRow, ReviewDetailRow, ReviewFeedbackRow, ReviewOutput, RevisionEditRow } from "./reviewTypes";
import { feedbackKey } from "./reviewTypes";
import { RISK_DOT } from "./reviewHelpers";
import { RECOMMENDATION_PILL, RISK_HEADER_LABEL, formatCreatedAt } from "./reviewLabels";

type LoadState =
    | { kind: "loading" }
    | { kind: "not_found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; detail: ContractReviewDetail };

/** Feedback keys that count toward "reviewed": one per finding the Draf view asks about. */
export function reviewableKeys(output: ReviewOutput): string[] {
    return [
        feedbackKey("executive_summary", "overall_recommendation"),
        ...Object.keys(output.playbook_compliance ?? {}).map((slug) => feedbackKey("playbook_rule", slug)),
        ...output.red_flags.map((f) => feedbackKey("red_flag", f.id)),
        ...output.revisions.map((r) => feedbackKey("revision", r.id)),
        ...output.clarifications.map((c) => feedbackKey("clarification", c.id)),
        ...output.financial_review.map((_, i) => feedbackKey("financial", `FIN-${i}`)),
        ...output.missing_clauses.map((_, i) => feedbackKey("missing_clause", `MC-${i}`)),
    ];
}

const GATE_LOCKED_STATUSES = new Set(["clevel_reviewed", "signed", "archived"]);

export function ReviewWorkspace({ reviewId }: { reviewId: string }) {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [state, setState] = useState<LoadState>({ kind: "loading" });
    const [gateBusy, setGateBusy] = useState(false);
    const [docRefetchKey, setDocRefetchKey] = useState(0);
    const [panelTab, setPanelTab] = useState<"draft" | "negotiation">("draft");
    const [memoGenerating, setMemoGenerating] = useState(false);
    const [memoError, setMemoError] = useState<string | null>(null);
    const [projecting, setProjecting] = useState(false);
    const [projectMessage, setProjectMessage] = useState<string | null>(null);
    const [activeQuote, setActiveQuote] = useState<string | null>(null);
    const [quoteFocusKey, setQuoteFocusKey] = useState(0);
    const locate = useCallback((text: string) => {
        setActiveQuote(text);
        setQuoteFocusKey((k) => k + 1);
    }, []);
    const [gateMessage, setGateMessage] = useState<string | null>(null);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        getContract(reviewId)
            .then((detail) => {
                if (!cancelled) setState({ kind: "ready", detail });
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                if (error instanceof MikeApiError && error.status === 404) setState({ kind: "not_found" });
                else setState({ kind: "error", message: "Tinjauan tidak dapat dimuat. Coba lagi." });
            });
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, reviewId]);

    const detail = state.kind === "ready" ? state.detail : null;
    const review = detail?.review ?? null;
    const output = review?.ai_output ?? null;

    const feedbackMap = useMemo(() => {
        const map = new Map<string, ReviewFeedbackRow>();
        for (const row of detail?.feedback ?? []) map.set(feedbackKey(row.finding_type, row.finding_id), row);
        return map;
    }, [detail?.feedback]);

    const onFeedbackSaved = useCallback((row: ReviewFeedbackRow) => {
        setState((prev) =>
            prev.kind === "ready" ? { kind: "ready", detail: { ...prev.detail, feedback: [...prev.detail.feedback, row] } } : prev,
        );
    }, []);

    const onReviewPatched = useCallback((patch: Partial<ReviewDetailRow> | ContractPatch) => {
        setState((prev) =>
            prev.kind === "ready"
                ? { kind: "ready", detail: { ...prev.detail, review: { ...prev.detail.review, ...(patch as Partial<ReviewDetailRow>) } } }
                : prev,
        );
    }, []);

    const editsByRevision = useMemo(() => {
        const map = new Map<string, RevisionEditRow>();
        for (const e of detail?.revisionEdits ?? []) map.set(e.revision_id, e);
        return map;
    }, [detail?.revisionEdits]);

    const onRevisionResolved = useCallback((edit: RevisionEditRow, feedback: ReviewFeedbackRow) => {
        setState((prev) => {
            if (prev.kind !== "ready") return prev;
            const edits = prev.detail.revisionEdits.some((e) => e.id === edit.id)
                ? prev.detail.revisionEdits.map((e) => (e.id === edit.id ? edit : e))
                : [...prev.detail.revisionEdits, edit];
            return { kind: "ready", detail: { ...prev.detail, revisionEdits: edits, feedback: [...prev.detail.feedback, feedback] } };
        });
        // The working DOCX changed on the server; make the viewer refetch it.
        setDocRefetchKey((k) => k + 1);
    }, []);

    const projectRedline = async () => {
        if (!review) return;
        setProjecting(true);
        setProjectMessage(null);
        try {
            const result = await projectContractRedline(review.id);
            setState((prev) =>
                prev.kind === "ready"
                    ? { kind: "ready", detail: { ...prev.detail, revisionEdits: result.edits, review: { ...prev.detail.review, contract_redline_path: result.projected > 0 ? `contracts/${review.id}/redline.docx` : prev.detail.review.contract_redline_path } } }
                    : prev,
            );
            setDocRefetchKey((k) => k + 1);
            setProjectMessage(`${result.projected} revisi dipetakan ke dokumen${result.failed ? `, ${result.failed} tidak dapat dipetakan` : ""}.`);
        } catch {
            setProjectMessage("Gagal memetakan revisi ke dokumen.");
        } finally {
            setProjecting(false);
        }
    };

    const generateMemo = useCallback(async (reviewId: string) => {
        setMemoGenerating(true);
        setMemoError(null);
        setPanelTab("negotiation");
        try {
            const result = await generateContractMemo(reviewId);
            setState((prev) =>
                prev.kind === "ready"
                    ? { kind: "ready", detail: { ...prev.detail, review: { ...prev.detail.review, negotiation_memo: result.memo, negotiation_memo_generated_at: result.generated_at } } }
                    : prev,
            );
        } catch (e) {
            setMemoError(userFacingApiError(e, "Gagal membuat memo negosiasi"));
        } finally {
            setMemoGenerating(false);
        }
    }, []);

    const onPointSaved = useCallback((row: NegotiationPointRow) => {
        setState((prev) => {
            if (prev.kind !== "ready") return prev;
            const rest = prev.detail.negotiationPoints.filter((p) => p.point_id !== row.point_id);
            return { kind: "ready", detail: { ...prev.detail, negotiationPoints: [...rest, row] } };
        });
    }, []);

    const progress = useMemo(() => {
        if (!output) return null;
        const keys = reviewableKeys(output);
        const reviewed = keys.filter((k) => feedbackMap.has(k)).length;
        return { total: keys.length, reviewed, percent: keys.length ? Math.round((reviewed / keys.length) * 100) : 0 };
    }, [output, feedbackMap]);

    const allReviewed = Boolean(progress && progress.total > 0 && progress.reviewed >= progress.total);
    const gateLocked = Boolean(review?.status && GATE_LOCKED_STATUSES.has(review.status));
    const alreadyReviewed = review?.status === "clevel_reviewed" || review?.status === "signed";

    const markCLevelReviewed = async () => {
        if (!review) return;
        setGateBusy(true);
        setGateMessage(null);
        try {
            const saved = await patchContract(review.id, { status: "clevel_reviewed", lifecycle_stage: "clevel_review" });
            onReviewPatched(saved);
            setGateMessage("Status diperbarui ke Ditinjau C-Level");
            // Janus: the hand-off to BD starts here — the memo is generated right away.
            void generateMemo(review.id);
        } catch {
            setGateMessage("Gagal memperbarui status. Coba lagi.");
        } finally {
            setGateBusy(false);
        }
    };

    const recommendation = review?.coo_recommendation_override ?? output?.overall_recommendation ?? null;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                shrink
                loading={state.kind === "loading"}
                breadcrumbs={[
                    { label: "Contracts", onClick: () => router.push("/contracts"), title: "Kembali ke Tinjauan Kontrak" },
                    state.kind === "loading" ? { loading: true, skeletonClassName: "w-40" } : { label: review?.title ?? "Tinjauan" },
                ]}
            />

            {state.kind === "loading" ? (
                <div className="p-8 text-sm text-gray-500">Memuat tinjauan...</div>
            ) : state.kind === "not_found" ? (
                <div className="p-8 text-sm text-gray-500">Tinjauan tidak ditemukan</div>
            ) : state.kind === "error" ? (
                <div className="p-8 text-sm text-red-600">{state.message}</div>
            ) : !review || !output ? (
                <div className="p-8 text-sm text-gray-500">
                    {review?.status === "failed" ? "Tinjauan gagal diproses. Unggah ulang kontrak." : "Tinjauan masih diproses..."}
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-6 py-3">
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate font-serif text-xl font-medium text-gray-900">{review.title}</h1>
                            <p className="mt-0.5 text-xs text-gray-500">
                                {review.document_type} · {review.client_name}
                                {review.created_at ? ` · Dibuat ${formatCreatedAt(review.created_at)}` : ""}
                            </p>
                        </div>
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1 text-xs font-medium text-gray-800">
                            <span className="h-2 w-2 rounded-full" style={{ background: RISK_DOT[output.risk_level] ?? "#9CA3AF" }} />
                            {RISK_HEADER_LABEL[output.risk_level] ?? output.risk_level}
                        </span>
                        {recommendation ? (
                            <span className="inline-flex items-center rounded-full bg-gray-900 px-3 py-1 text-xs font-semibold tracking-wide text-white">
                                {RECOMMENDATION_PILL[recommendation] ?? recommendation}
                            </span>
                        ) : null}
                        <StatusPill review={review} onUpdate={onReviewPatched} />
                        {review.contract_docx_path ? (
                            <a
                                href={getContractDownloadUrl(review.id)}
                                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-gray-200 px-3 text-xs font-medium text-gray-800 hover:bg-gray-50"
                                title={review.contract_redline_path ? "Unduh kontrak redline (DOCX)" : "Unduh kontrak asli (DOCX)"}
                            >
                                <Download className="h-3.5 w-3.5" /> Ekspor
                            </a>
                        ) : null}
                        {review.contract_docx_path && (output.revisions.length > editsByRevision.size) ? (
                            <PillButtonUI tone="white" size="xs" onClick={projectRedline} loading={projecting}>
                                <FileDiff className="mr-1 h-3 w-3" /> Petakan revisi ke dokumen
                            </PillButtonUI>
                        ) : null}
                        {projectMessage ? <span className="text-xs text-gray-600" role="status">{projectMessage}</span> : null}
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                        <div className={review.contract_docx_path ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto bg-gray-100 p-6"}>
                            <ContractDocument review={review} activeQuote={activeQuote} quoteFocusKey={quoteFocusKey} refetchKey={docRefetchKey} />
                        </div>
                        <aside className="flex min-h-0 w-full flex-col border-t border-gray-200 bg-gray-50 lg:w-[440px] lg:border-l lg:border-t-0 xl:w-[500px]">
                            <div className="flex items-center gap-1 border-b border-gray-200 bg-white px-3 pt-2" role="tablist">
                                {(
                                    [
                                        { id: "draft", label: "Draf", disabled: false },
                                        { id: "negotiation", label: "Negosiasi", disabled: !review.negotiation_memo && !memoGenerating },
                                    ] as const
                                ).map((tab) => (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={panelTab === tab.id}
                                        disabled={tab.disabled}
                                        onClick={() => setPanelTab(tab.id)}
                                        className={`-mb-px border-b-2 px-3 py-2 text-sm ${panelTab === tab.id ? "border-gray-900 font-medium text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"} disabled:cursor-not-allowed disabled:opacity-40`}
                                        title={tab.disabled ? "Memo negosiasi belum tersedia" : undefined}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                            <div className={panelTab === "negotiation" ? "min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-5" : "min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-5 pb-28"}>
                                {panelTab === "negotiation" ? (
                                    <NegotiationTab
                                        reviewId={review.id}
                                        clientName={review.client_name}
                                        memo={review.negotiation_memo}
                                        generatedAt={review.negotiation_memo_generated_at}
                                        generating={memoGenerating}
                                        error={memoError}
                                        points={state.detail.negotiationPoints}
                                        onRegenerate={() => void generateMemo(review.id)}
                                        onPointSaved={onPointSaved}
                                    />
                                ) : (
                                <DraftFindings
                                    review={review}
                                    output={output}
                                    feedbackMap={feedbackMap}
                                    onFeedbackSaved={onFeedbackSaved}
                                    onReviewPatched={onReviewPatched}
                                    onLocate={locate}
                                    editsByRevision={editsByRevision}
                                    onRevisionResolved={onRevisionResolved}
                                />
                                )}
                            </div>
                            {progress && panelTab === "draft" ? (
                                <div className="border-t border-gray-200 bg-white px-5 py-3">
                                    <div className="flex items-center justify-between text-xs text-gray-600">
                                        <span data-testid="progress-label">
                                            {progress.reviewed} dari {progress.total} temuan ditinjau
                                        </span>
                                        <span>{progress.percent}%</span>
                                    </div>
                                    <div className="mt-1.5 h-[3px] w-full rounded bg-gray-200">
                                        <div
                                            className="h-[3px] rounded"
                                            style={{ width: `${progress.percent}%`, background: progress.percent === 100 ? "#16A34A" : "#111827" }}
                                        />
                                    </div>
                                    <div className="mt-3 flex items-center gap-3">
                                        <PillButtonUI
                                            tone="black"
                                            size="sm"
                                            onClick={markCLevelReviewed}
                                            disabled={!allReviewed || gateLocked}
                                            loading={gateBusy}
                                        >
                                            {alreadyReviewed ? "Ditinjau C-Level ✓" : "Tandai Sudah Ditinjau C-Level"}
                                        </PillButtonUI>
                                        {gateMessage ? <span className="text-xs text-gray-600" role="status">{gateMessage}</span> : null}
                                    </div>
                                </div>
                            ) : null}
                        </aside>
                    </div>
                </>
            )}
        </div>
    );
}

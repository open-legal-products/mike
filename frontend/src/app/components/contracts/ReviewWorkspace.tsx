"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { MikeApiError, getContract } from "@/app/lib/mikeApi";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { ContractHtmlView } from "./ContractHtmlView";
import { DraftFindings } from "./DraftFindings";
import type { ContractReviewDetail } from "./reviewTypes";
import { RISK_DOT } from "./reviewHelpers";
import { RECOMMENDATION_PILL, RISK_HEADER_LABEL, formatCreatedAt } from "./reviewLabels";

type LoadState =
    | { kind: "loading" }
    | { kind: "not_found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; detail: ContractReviewDetail };

export function ReviewWorkspace({ reviewId }: { reviewId: string }) {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const [state, setState] = useState<LoadState>({ kind: "loading" });

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        getContract(reviewId)
            .then((detail) => {
                if (!cancelled) setState({ kind: "ready", detail });
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                if (error instanceof MikeApiError && error.status === 404) {
                    setState({ kind: "not_found" });
                } else {
                    setState({ kind: "error", message: "Tinjauan tidak dapat dimuat. Coba lagi." });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, reviewId]);

    const review = state.kind === "ready" ? state.detail.review : null;
    const output = review?.ai_output ?? null;
    const recommendation = review?.coo_recommendation_override ?? output?.overall_recommendation ?? null;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                shrink
                loading={state.kind === "loading"}
                breadcrumbs={[
                    { label: "Contracts", onClick: () => router.push("/contracts"), title: "Kembali ke Tinjauan Kontrak" },
                    state.kind === "loading"
                        ? { loading: true, skeletonClassName: "w-40" }
                        : { label: review?.title ?? "Tinjauan" },
                ]}
            />

            {state.kind === "loading" ? (
                <div className="p-8 text-sm text-gray-500">Memuat tinjauan...</div>
            ) : state.kind === "not_found" ? (
                <div className="p-8 text-sm text-gray-500">Tinjauan tidak ditemukan</div>
            ) : state.kind === "error" ? (
                <div className="p-8 text-sm text-red-600">{state.message}</div>
            ) : !output ? (
                <div className="p-8 text-sm text-gray-500">
                    {review?.status === "failed" ? "Tinjauan gagal diproses. Unggah ulang kontrak." : "Tinjauan masih diproses..."}
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-6 py-3">
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate font-serif text-xl font-medium text-gray-900">{review?.title}</h1>
                            <p className="mt-0.5 text-xs text-gray-500">
                                {review?.document_type} · {review?.client_name}
                                {review?.created_at ? ` · Dibuat ${formatCreatedAt(review.created_at)}` : ""}
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
                    </div>

                    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                        <div className="min-h-0 flex-1 overflow-y-auto bg-gray-100 p-6">
                            <ContractHtmlView html={review?.contract_html ?? null} text={review?.contract_text ?? null} />
                        </div>
                        <aside className="min-h-0 w-full overflow-y-auto border-t border-gray-200 bg-gray-50 p-5 lg:w-[440px] lg:border-l lg:border-t-0 xl:w-[500px]">
                            <DraftFindings output={output} />
                        </aside>
                    </div>
                </>
            )}
        </div>
    );
}

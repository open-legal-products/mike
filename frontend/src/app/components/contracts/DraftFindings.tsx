"use client";

import { useState, type ReactNode } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { patchContract, postContractFeedback, saveContractClause } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { ReviewDetailRow, ReviewFeedbackRow, ReviewOutput } from "./reviewTypes";
import { feedbackKey } from "./reviewTypes";
import { FeedbackRecorded, FeedbackWidget } from "./FeedbackWidget";
import {
    ASSESSMENT_COLOR,
    PLAYBOOK_LABELS,
    PLAYBOOK_STATUS_COLOR,
    PLAYBOOK_STATUS_LABEL,
    PRIORITY_COLOR,
    PRIORITY_LABEL,
    SECTION_TITLES,
    SEVERITY_COLOR,
} from "./reviewLabels";

// The "Draf" view: every AI finding as a card, in Janus order with verbatim
// Bahasa section titles, each with its FeedbackWidget variant. Synthetic ids
// (FIN-{i}, MC-{i}) match Janus so feedback rows join correctly. A finding that
// already has feedback shows the recorded state instead of the buttons.

export function Badge({ children, color }: { children: ReactNode; color: string }) {
    return (
        <span
            className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{ color, borderColor: color }}
        >
            {children}
        </span>
    );
}

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
    return (
        <section className="space-y-3">
            <h2 className="font-serif text-base font-medium text-gray-900">
                {title}
                {typeof count === "number" ? <span className="ml-1 text-gray-400">({count})</span> : null}
            </h2>
            {children}
        </section>
    );
}

export function Card({ children, accent }: { children: ReactNode; accent?: string }) {
    return (
        <div
            className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-800"
            style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
        >
            {children}
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <p className="mt-2">
            <span className="font-medium text-gray-900">{label}</span> {children}
        </p>
    );
}

const RECOMMENDATION_OPTIONS = [
    { value: "READY_TO_SIGN", label: "Siap Ditandatangani" },
    { value: "NEEDS_REVISIONS", label: "Perlu Revisi" },
    { value: "ESCALATE_TO_CEO_COO", label: "Eskalasi ke CEO/COO" },
    { value: "DO_NOT_SIGN", label: "Jangan Ditandatangani" },
];

function SaveClauseButton({ reviewId, title, wording }: { reviewId: string; title: string; wording: string }) {
    const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
    const save = async () => {
        setState("saving");
        try {
            await saveContractClause(reviewId, { title, wording });
            setState("saved");
        } catch {
            setState("error");
        }
    };
    if (state === "saved") return <span className="text-xs text-emerald-700">Tersimpan ke Pustaka Klausul</span>;
    return (
        <button
            type="button"
            onClick={save}
            disabled={state === "saving"}
            className="text-xs text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline disabled:opacity-50"
        >
            {state === "error" ? "Gagal menyimpan — coba lagi" : "💾 Simpan ke Pustaka"}
        </button>
    );
}

export interface DraftFindingsProps {
    review: ReviewDetailRow;
    output: ReviewOutput;
    feedbackMap: Map<string, ReviewFeedbackRow>;
    onFeedbackSaved: (row: ReviewFeedbackRow) => void;
    onReviewPatched: (patch: Partial<ReviewDetailRow>) => void;
}

export function DraftFindings({ review, output, feedbackMap, onFeedbackSaved, onReviewPatched }: DraftFindingsProps) {
    const reviewId = review.id;
    const fb = (type: string, id: string) => feedbackMap.get(feedbackKey(type, id)) ?? null;
    const playbookEntries = Object.entries(output.playbook_compliance ?? {});

    return (
        <div className="space-y-8">
            <Section title={SECTION_TITLES.executive}>
                <Card>
                    <p className="leading-6">{output.executive_summary}</p>
                    {output.template_used ? (
                        <p className="mt-3 text-xs text-gray-500">
                            Template: <Badge color="#6B7280">{output.template_used}</Badge>
                        </p>
                    ) : null}
                    <ExecutiveSummaryFeedback
                        review={review}
                        output={output}
                        existing={fb("executive_summary", "overall_recommendation")}
                        onFeedbackSaved={onFeedbackSaved}
                        onReviewPatched={onReviewPatched}
                    />
                </Card>
            </Section>

            {playbookEntries.length > 0 ? (
                <Section title={SECTION_TITLES.playbook}>
                    <div className="space-y-2">
                        {playbookEntries.map(([slug, item]) => (
                            <Card key={slug} accent={PLAYBOOK_STATUS_COLOR[item.status]}>
                                <div className="flex items-start justify-between gap-3">
                                    <span className="font-medium text-gray-900">{PLAYBOOK_LABELS[slug] ?? slug}</span>
                                    <Badge color={PLAYBOOK_STATUS_COLOR[item.status] ?? "#6B7280"}>
                                        {PLAYBOOK_STATUS_LABEL[item.status] ?? item.status}
                                    </Badge>
                                </div>
                                <p className="mt-2 leading-6 text-gray-700">{item.assessment}</p>
                                {item.clause_reference ? <p className="mt-1 text-xs text-gray-500">Referensi Pasal: {item.clause_reference}</p> : null}
                                {item.clause_text ? <p className="mt-1 text-xs text-gray-500">Teks Kontrak: {item.clause_text}</p> : null}
                                {item.playbook_threshold ? <p className="mt-1 text-xs text-gray-500">Standar Playbook: {item.playbook_threshold}</p> : null}
                                <FeedbackWidget
                                    reviewId={reviewId}
                                    findingType="playbook_rule"
                                    findingId={slug}
                                    variant="validate"
                                    originalSeverity={item.status}
                                    existing={fb("playbook_rule", slug)}
                                    onSaved={onFeedbackSaved}
                                />
                            </Card>
                        ))}
                    </div>
                </Section>
            ) : null}

            <Section title={SECTION_TITLES.redFlags} count={output.red_flags.length}>
                {output.red_flags.map((flag) => (
                    <Card key={flag.id} accent={SEVERITY_COLOR[flag.severity]}>
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <span className="mr-2 font-mono text-xs text-gray-400">{flag.id}</span>
                                <span className="font-medium text-gray-900">{flag.title}</span>
                            </div>
                            <Badge color={SEVERITY_COLOR[flag.severity]}>{flag.severity}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">{flag.clause}{flag.playbook_rule ? ` · ${flag.playbook_rule}` : ""}</p>
                        <p className="mt-2 leading-6">{flag.issue}</p>
                        <Field label="Dampak:">{flag.business_impact}</Field>
                        <Field label="Tindakan:">{flag.action}</Field>
                        {flag.requires_approval ? (
                            <p className="mt-2 text-xs font-medium text-amber-700">Memerlukan persetujuan {flag.requires_approval}</p>
                        ) : null}
                        <FeedbackWidget
                            reviewId={reviewId}
                            findingType="red_flag"
                            findingId={flag.id}
                            variant="validate"
                            originalSeverity={flag.severity}
                            existing={fb("red_flag", flag.id)}
                            onSaved={onFeedbackSaved}
                        />
                    </Card>
                ))}
            </Section>

            <Section title={SECTION_TITLES.revisions} count={output.revisions.length}>
                {output.revisions.map((rev) => (
                    <Card key={rev.id} accent="#2563EB">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <span className="mr-2 font-mono text-xs text-gray-400">{rev.id}</span>
                                <span className="font-medium text-gray-900">{rev.clause}</span>
                            </div>
                            <Badge color={PRIORITY_COLOR[rev.priority]}>{PRIORITY_LABEL[rev.priority] ?? rev.priority}</Badge>
                        </div>
                        <div className="mt-3 rounded-lg bg-red-50 p-3 text-red-900 line-through decoration-red-400">{rev.original_text}</div>
                        <div className="mt-2 rounded-lg bg-emerald-50 p-3 text-emerald-900">{rev.suggested_text}</div>
                        <Field label="Alasan:">{rev.rationale}</Field>
                        {rev.from_clause_library && rev.clause_library_source ? (
                            <p className="mt-2 text-xs text-gray-500">Dari Pustaka Klausul: {rev.clause_library_source}</p>
                        ) : null}
                        <FeedbackWidget
                            reviewId={reviewId}
                            findingType="revision"
                            findingId={rev.id}
                            variant="revise"
                            originalText={rev.suggested_text}
                            existing={fb("revision", rev.id)}
                            onSaved={onFeedbackSaved}
                        />
                        <div className="mt-2">
                            <SaveClauseButton reviewId={reviewId} title={`${rev.clause} — ${review.client_name ?? ""}`} wording={rev.suggested_text} />
                        </div>
                    </Card>
                ))}
            </Section>

            <Section title={SECTION_TITLES.clarifications} count={output.clarifications.length}>
                {output.clarifications.map((clr) => (
                    <Card key={clr.id} accent="#CA8A04">
                        <span className="mr-2 font-mono text-xs text-gray-400">{clr.id}</span>
                        <span className="font-medium text-gray-900">{clr.question}</span>
                        <p className="mt-1 text-xs text-gray-500">{clr.clause} · {clr.assign_to}</p>
                        <FeedbackWidget
                            reviewId={reviewId}
                            findingType="clarification"
                            findingId={clr.id}
                            variant="answer"
                            existing={fb("clarification", clr.id)}
                            onSaved={onFeedbackSaved}
                        />
                    </Card>
                ))}
            </Section>

            {output.financial_review.length > 0 ? (
                <Section title={SECTION_TITLES.financial}>
                    {output.financial_review.map((item, i) => {
                        const id = `FIN-${i}`;
                        return (
                            <Card key={id} accent={ASSESSMENT_COLOR[item.assessment]}>
                                <div className="flex items-start justify-between gap-3">
                                    <span className="font-medium text-gray-900">{item.item}</span>
                                    <Badge color={ASSESSMENT_COLOR[item.assessment] ?? "#6B7280"}>{item.assessment}</Badge>
                                </div>
                                <p className="mt-2 leading-6">{item.finding}</p>
                                <Field label="Rekomendasi:">{item.recommendation}</Field>
                                <FeedbackWidget
                                    reviewId={reviewId}
                                    findingType="financial"
                                    findingId={id}
                                    variant="validate"
                                    originalSeverity={item.assessment}
                                    existing={fb("financial", id)}
                                    onSaved={onFeedbackSaved}
                                />
                            </Card>
                        );
                    })}
                </Section>
            ) : null}

            <Section title={SECTION_TITLES.missing} count={output.missing_clauses.length}>
                {output.missing_clauses.map((mc, i) => {
                    const id = `MC-${i}`;
                    return (
                        <Card key={id} accent={SEVERITY_COLOR[mc.importance]}>
                            <div className="flex items-start justify-between gap-3">
                                <span className="font-medium text-gray-900">{mc.clause_name}</span>
                                <Badge color={SEVERITY_COLOR[mc.importance] ?? "#6B7280"}>{mc.importance}</Badge>
                            </div>
                            <p className="mt-2 leading-6">{mc.description}</p>
                            <div className="mt-2 rounded-lg bg-gray-50 p-3 font-serif text-gray-800">{mc.suggested_wording}</div>
                            {mc.from_clause_library && mc.clause_library_source ? (
                                <p className="mt-2 text-xs text-gray-500">Dari Pustaka Klausul: {mc.clause_library_source}</p>
                            ) : null}
                            <FeedbackWidget
                                reviewId={reviewId}
                                findingType="missing_clause"
                                findingId={id}
                                variant="add-skip"
                                existing={fb("missing_clause", id)}
                                onSaved={onFeedbackSaved}
                            />
                            <div className="mt-2">
                                <SaveClauseButton reviewId={reviewId} title={mc.clause_name} wording={mc.suggested_wording} />
                            </div>
                        </Card>
                    );
                })}
            </Section>

            {output.yellow_flags.length > 0 ? (
                <Section title={SECTION_TITLES.yellow}>
                    {output.yellow_flags.map((yf, i) => (
                        <Card key={`YF-${i}`} accent="#D97706">
                            <span className="font-medium text-gray-900">{yf.item}</span>
                            {yf.clause ? <p className="mt-1 text-xs text-gray-500">{yf.clause}</p> : null}
                            <p className="mt-2 leading-6">{yf.note}</p>
                        </Card>
                    ))}
                </Section>
            ) : null}

            {output.positive_findings.length > 0 ? (
                <Section title={SECTION_TITLES.positive}>
                    {output.positive_findings.map((pf, i) => (
                        <Card key={`PF-${i}`} accent="#059669">
                            <p className="text-xs text-gray-500">{pf.clause}</p>
                            <p className="mt-1 leading-6">{pf.finding}</p>
                        </Card>
                    ))}
                </Section>
            ) : null}
        </div>
    );
}

function ExecutiveSummaryFeedback({
    review,
    output,
    existing,
    onFeedbackSaved,
    onReviewPatched,
}: {
    review: ReviewDetailRow;
    output: ReviewOutput;
    existing: ReviewFeedbackRow | null;
    onFeedbackSaved: (row: ReviewFeedbackRow) => void;
    onReviewPatched: (patch: Partial<ReviewDetailRow>) => void;
}) {
    const [mode, setMode] = useState<"idle" | "override">("idle");
    const [overrideRec, setOverrideRec] = useState("");
    const [rationale, setRationale] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (existing) {
        return (
            <div>
                <FeedbackRecorded feedback={existing} />
                {review.coo_recommendation_override ? (
                    <p className="mt-1 text-xs text-gray-500">
                        Koreksi C-Level: {RECOMMENDATION_OPTIONS.find((o) => o.value === review.coo_recommendation_override)?.label}
                        {review.coo_override_rationale ? ` — ${review.coo_override_rationale}` : ""}
                    </p>
                ) : null}
            </div>
        );
    }

    const agree = async () => {
        setBusy(true);
        setError(null);
        try {
            const row = await postContractFeedback(review.id, {
                finding_type: "executive_summary",
                finding_id: "overall_recommendation",
                action: "valid",
                original_severity: output.overall_recommendation,
            });
            onFeedbackSaved(row);
        } catch (e) {
            setError(userFacingApiError(e, "Persetujuan gagal disimpan."));
        } finally {
            setBusy(false);
        }
    };

    const saveOverride = async () => {
        setBusy(true);
        setError(null);
        try {
            const patched = await patchContract(review.id, {
                coo_recommendation_override: overrideRec,
                coo_override_rationale: rationale || null,
            });
            onReviewPatched({
                coo_recommendation_override: patched.coo_recommendation_override ?? overrideRec,
                coo_override_rationale: patched.coo_override_rationale ?? (rationale || null),
            });
            const row = await postContractFeedback(review.id, {
                finding_type: "executive_summary",
                finding_id: "overall_recommendation",
                action: "override",
                original_severity: output.overall_recommendation,
                adjusted_severity: overrideRec,
                rationale: rationale || null,
            });
            onFeedbackSaved(row);
        } catch (e) {
            setError(userFacingApiError(e, "Koreksi gagal disimpan."));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="mt-3 space-y-2 border-t border-gray-100 pt-2.5">
            <p className="text-xs font-medium text-gray-700">Setuju dengan penilaian?</p>
            {mode === "idle" ? (
                <div className="flex gap-2">
                    <PillButtonUI tone="white" size="xs" onClick={agree} loading={busy}>Setuju</PillButtonUI>
                    <PillButtonUI tone="white" size="xs" onClick={() => setMode("override")} disabled={busy}>Koreksi</PillButtonUI>
                </div>
            ) : (
                <div className="space-y-2">
                    <select
                        aria-label="Pilih rekomendasi"
                        value={overrideRec}
                        onChange={(e) => setOverrideRec(e.target.value)}
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm"
                    >
                        <option value="">Pilih rekomendasi</option>
                        {RECOMMENDATION_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                    <textarea
                        value={rationale}
                        onChange={(e) => setRationale(e.target.value)}
                        placeholder="Alasan Anda..."
                        rows={2}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400"
                    />
                    <div className="flex items-center gap-3">
                        <PillButtonUI tone="black" size="xs" onClick={saveOverride} disabled={!overrideRec} loading={busy}>Simpan Koreksi</PillButtonUI>
                        <button type="button" onClick={() => setMode("idle")} className="text-xs text-gray-500 hover:text-gray-800">Batalkan</button>
                    </div>
                </div>
            )}
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
    );
}

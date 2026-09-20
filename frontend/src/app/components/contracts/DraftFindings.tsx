"use client";

import type { ReactNode } from "react";
import type { ReviewOutput } from "./reviewTypes";
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

// The "Draf" view: every AI finding as a card, in the same order and with the
// same Bahasa section titles as Janus. Slice 1 renders read-only; slice 2 adds
// the FeedbackWidget per card. Synthetic ids (FIN-{i}, MC-{i}) match Janus so
// feedback rows written later join correctly.

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

export function DraftFindings({ output }: { output: ReviewOutput }) {
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
                </Card>
            </Section>

            {playbookEntries.length > 0 ? (
                <Section title={SECTION_TITLES.playbook}>
                    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                        <table className="w-full text-sm">
                            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                                <tr>
                                    <th className="px-3 py-2">Aturan</th>
                                    <th className="px-3 py-2">Status</th>
                                    <th className="px-3 py-2">Penilaian AI</th>
                                </tr>
                            </thead>
                            <tbody>
                                {playbookEntries.map(([slug, item]) => (
                                    <tr key={slug} className="border-t border-gray-100 align-top">
                                        <td className="px-3 py-2 font-medium text-gray-900">{PLAYBOOK_LABELS[slug] ?? slug}</td>
                                        <td className="px-3 py-2">
                                            <Badge color={PLAYBOOK_STATUS_COLOR[item.status] ?? "#6B7280"}>
                                                {PLAYBOOK_STATUS_LABEL[item.status] ?? item.status}
                                            </Badge>
                                        </td>
                                        <td className="px-3 py-2 text-gray-700">
                                            {item.assessment}
                                            {item.clause_reference ? (
                                                <div className="mt-1 text-xs text-gray-500">Referensi Pasal: {item.clause_reference}</div>
                                            ) : null}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
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
                    </Card>
                ))}
            </Section>

            <Section title={SECTION_TITLES.clarifications} count={output.clarifications.length}>
                {output.clarifications.map((clr) => (
                    <Card key={clr.id} accent="#CA8A04">
                        <span className="mr-2 font-mono text-xs text-gray-400">{clr.id}</span>
                        <span className="font-medium text-gray-900">{clr.question}</span>
                        <p className="mt-1 text-xs text-gray-500">{clr.clause} · {clr.assign_to}</p>
                    </Card>
                ))}
            </Section>

            {output.financial_review.length > 0 ? (
                <Section title={SECTION_TITLES.financial}>
                    {output.financial_review.map((item, i) => (
                        <Card key={`FIN-${i}`} accent={ASSESSMENT_COLOR[item.assessment]}>
                            <div className="flex items-start justify-between gap-3">
                                <span className="font-medium text-gray-900">{item.item}</span>
                                <Badge color={ASSESSMENT_COLOR[item.assessment] ?? "#6B7280"}>{item.assessment}</Badge>
                            </div>
                            <p className="mt-2 leading-6">{item.finding}</p>
                            <Field label="Rekomendasi:">{item.recommendation}</Field>
                        </Card>
                    ))}
                </Section>
            ) : null}

            <Section title={SECTION_TITLES.missing} count={output.missing_clauses.length}>
                {output.missing_clauses.map((mc, i) => (
                    <Card key={`MC-${i}`} accent={SEVERITY_COLOR[mc.importance]}>
                        <div className="flex items-start justify-between gap-3">
                            <span className="font-medium text-gray-900">{mc.clause_name}</span>
                            <Badge color={SEVERITY_COLOR[mc.importance] ?? "#6B7280"}>{mc.importance}</Badge>
                        </div>
                        <p className="mt-2 leading-6">{mc.description}</p>
                        <div className="mt-2 rounded-lg bg-gray-50 p-3 font-serif text-gray-800">{mc.suggested_wording}</div>
                        {mc.from_clause_library && mc.clause_library_source ? (
                            <p className="mt-2 text-xs text-gray-500">Dari Pustaka Klausul: {mc.clause_library_source}</p>
                        ) : null}
                    </Card>
                ))}
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

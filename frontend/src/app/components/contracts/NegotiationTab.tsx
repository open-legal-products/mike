"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Loader2, Lock, RefreshCw, Shield } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { setNegotiationPointStatus } from "@/app/lib/mikeApi";
import type { NegotiationMemo, NegotiationPoint, NegotiationPointRow, NegotiationStatus } from "./reviewTypes";

// Negosiasi tab (ported from Janus): the BD memo with per-point status. Labels
// verbatim. Memo generation itself is triggered by the workspace (C-Level gate
// or "Buat Ulang").

const TONE: Record<string, { label: string; className: string }> = {
    cooperative: { label: "Kooperatif", className: "bg-emerald-50 text-emerald-800 border-emerald-200" },
    firm: { label: "Tegas", className: "bg-amber-50 text-amber-800 border-amber-200" },
    cautious: { label: "Hati-hati", className: "bg-red-50 text-red-800 border-red-200" },
};

export const NEGOTIATION_STATUS_OPTIONS: { value: NegotiationStatus; label: string }[] = [
    { value: "pending", label: "Belum Dibahas" },
    { value: "agreed", label: "Disetujui Klien" },
    { value: "rejected", label: "Ditolak Klien" },
    { value: "escalated", label: "Perlu Eskalasi" },
];

const STATUS_CLASS: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    agreed: "bg-emerald-100 text-emerald-700",
    rejected: "bg-red-100 text-red-700",
    escalated: "bg-amber-100 text-amber-700",
};

export function memoToMarkdown(memo: NegotiationMemo): string {
    const lines: string[] = [];
    lines.push(`# ${memo.memo_title}\n`);
    lines.push(`**Tone:** ${memo.overall_tone_recommendation} — ${memo.tone_explanation}\n`);
    lines.push(`## Pembukaan\n${memo.opening_statement}\n`);
    const renderPoints = (title: string, points: NegotiationPoint[]) => {
        if (points.length === 0) return;
        lines.push(`## ${title}\n`);
        for (const p of points) {
            lines.push(`### ${p.id}: ${p.title}`);
            lines.push(`- **Pasal:** ${p.clause_reference}`);
            lines.push(`- **Yang diminta:** ${p.what_to_ask}`);
            lines.push(`- **Dampak bisnis:** ${p.business_impact}`);
            lines.push(`- **Posisi ideal:** ${p.ideal_position}`);
            lines.push(`- **Posisi fallback:** ${p.fallback_position}`);
            lines.push(`- **Skrip bicara:** ${p.talking_script}\n`);
        }
    };
    renderPoints("WAJIB DIUBAH", memo.must_change);
    renderPoints("SEBAIKNYA DIUBAH", memo.should_change);
    renderPoints("BISA DIBICARAKAN", memo.nice_to_discuss);
    if (memo.do_not_raise.length > 0) {
        lines.push("## JANGAN DIANGKAT\n");
        for (const d of memo.do_not_raise) lines.push(`- **${d.title}:** ${d.reason}`);
        lines.push("");
    }
    if (memo.red_lines.length > 0) {
        lines.push("## GARIS MERAH\n");
        for (const r of memo.red_lines) lines.push(`- ${r.description} — ${r.reason}`);
        lines.push("");
    }
    lines.push(`## Penutup\n${memo.closing_guidance}`);
    return lines.join("\n");
}

function CopyButton({ text, label = "Salin" }: { text: string; label?: string }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard unavailable */
        }
    };
    return (
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900">
            <Copy className="h-3 w-3" /> {copied ? "Disalin ke clipboard" : label}
        </button>
    );
}

function PointCard({
    point,
    accent,
    status,
    onStatusChange,
}: {
    point: NegotiationPoint;
    accent: string;
    status: NegotiationStatus;
    onStatusChange: (pointId: string, status: NegotiationStatus) => void;
}) {
    const [expanded, setExpanded] = useState(true);
    return (
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm" style={{ borderLeft: `3px solid ${accent}` }}>
            <div className="flex items-start justify-between gap-3">
                <button type="button" onClick={() => setExpanded(!expanded)} className="flex flex-1 items-center gap-2 text-left">
                    {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                    <span className="font-medium text-gray-900">{point.title}</span>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600">{point.clause_reference}</span>
                    <select
                        aria-label={`Status ${point.id}`}
                        value={status}
                        onChange={(e) => onStatusChange(point.id, e.target.value as NegotiationStatus)}
                        className={`rounded-lg px-2 py-1 text-xs ${STATUS_CLASS[status] ?? ""}`}
                    >
                        {NEGOTIATION_STATUS_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                </div>
            </div>
            {expanded ? (
                <div className="mt-3 space-y-2 text-gray-800">
                    <p><span className="font-medium text-gray-900">Yang harus diminta</span> — {point.what_to_ask}</p>
                    <p><span className="font-medium text-gray-900">Dampak bisnis</span> — {point.business_impact}</p>
                    <p><span className="font-medium text-gray-900">Posisi ideal</span> — {point.ideal_position}</p>
                    <p><span className="font-medium text-gray-900">Posisi fallback</span> — {point.fallback_position}</p>
                    <div className="rounded-lg bg-gray-50 p-3">
                        <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs font-medium text-gray-900">Skrip bicara</span>
                            <CopyButton text={point.talking_script} label="Salin skrip" />
                        </div>
                        <p className="italic leading-6">{point.talking_script}</p>
                    </div>
                    {point.source_finding_ids?.length ? (
                        <p className="text-xs text-gray-500">Sumber: dari {point.source_finding_ids.join(", ")}</p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

export interface NegotiationTabProps {
    reviewId: string;
    clientName: string | null;
    memo: NegotiationMemo | null;
    generatedAt: string | null;
    generating: boolean;
    error?: string | null;
    points: NegotiationPointRow[];
    onRegenerate: () => void;
    onPointSaved: (row: NegotiationPointRow) => void;
}

export function NegotiationTab({ reviewId, clientName, memo, generatedAt, generating, error, points, onRegenerate, onPointSaved }: NegotiationTabProps) {
    const [saveError, setSaveError] = useState<string | null>(null);
    const statusOf = (pointId: string): NegotiationStatus => points.find((p) => p.point_id === pointId)?.status ?? "pending";

    const changeStatus = async (pointId: string, status: NegotiationStatus) => {
        setSaveError(null);
        try {
            onPointSaved(await setNegotiationPointStatus(reviewId, pointId, status));
        } catch {
            setSaveError("Gagal menyimpan status");
        }
    };

    if (generating) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <Loader2 className="mb-4 h-10 w-10 animate-spin text-gray-700" />
                <p className="text-base font-medium text-gray-900">Membuat Memo Negosiasi...</p>
                <p className="mt-1 text-sm text-gray-500">AI sedang menganalisis keputusan C-Level dan menyusun strategi negosiasi.</p>
            </div>
        );
    }

    if (!memo) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center text-gray-500">
                <Lock className="mb-4 h-10 w-10 opacity-50" />
                <p className="text-base font-medium text-gray-900">Memo Negosiasi Belum Tersedia</p>
                <p className="mt-1 max-w-md text-sm">
                    Selesaikan tinjauan C-Level terlebih dahulu untuk menghasilkan memo negosiasi. Klik &quot;Tandai Sudah Ditinjau C-Level&quot; di footer setelah semua temuan ditinjau.
                </p>
                {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
            </div>
        );
    }

    const tone = TONE[memo.overall_tone_recommendation] ?? TONE.cooperative;
    const allPoints = [...memo.must_change, ...memo.should_change, ...memo.nice_to_discuss].map((p) => p.id);
    const resolved = allPoints.filter((id) => statusOf(id) !== "pending").length;

    const section = (title: string, color: string, pts: NegotiationPoint[]) =>
        pts.length ? (
            <section className="space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold" style={{ color }}>
                    {title} <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700">{pts.length}</span>
                </h3>
                {pts.map((p) => (
                    <PointCard key={p.id} point={p} accent={color} status={statusOf(p.id)} onStatusChange={changeStatus} />
                ))}
            </section>
        ) : null;

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="font-serif text-lg font-medium text-gray-900">{memo.memo_title}</h2>
                    <p className="text-xs text-gray-500">
                        {clientName}
                        {generatedAt
                            ? ` • Dibuat ${new Date(generatedAt).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
                            : ""}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">{resolved} dari {allPoints.length} poin sudah dibahas</p>
                </div>
                <div className="flex items-center gap-2">
                    <PillButtonUI tone="white" size="xs" onClick={() => void navigator.clipboard?.writeText(memoToMarkdown(memo))}>
                        <Copy className="mr-1 h-3 w-3" /> Salin Memo
                    </PillButtonUI>
                    <PillButtonUI tone="white" size="xs" onClick={onRegenerate}>
                        <RefreshCw className="mr-1 h-3 w-3" /> Buat Ulang
                    </PillButtonUI>
                </div>
            </div>
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
            {saveError ? <p className="text-xs text-red-600">{saveError}</p> : null}

            <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-sm">
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${tone.className}`}>{tone.label}</span>
                <p className="text-gray-800">{memo.tone_explanation}</p>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium text-gray-900">Kalimat Pembuka</h3>
                    <CopyButton text={memo.opening_statement} />
                </div>
                <blockquote className="rounded-r-md border-l-4 border-gray-300 bg-gray-50 p-4 text-sm italic leading-6 text-gray-800">{memo.opening_statement}</blockquote>
            </div>

            {section("WAJIB DIUBAH", "#B91C1C", memo.must_change)}
            {section("SEBAIKNYA DIUBAH", "#B45309", memo.should_change)}
            {section("BISA DIBICARAKAN", "#1D4ED8", memo.nice_to_discuss)}

            {memo.do_not_raise.length ? (
                <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-gray-600">JANGAN DIANGKAT</h3>
                    {memo.do_not_raise.map((d) => (
                        <div key={d.id} className="rounded-xl border border-gray-200 bg-white p-3 text-sm">
                            <span className="font-medium text-gray-900">{d.title}</span> — <span className="text-gray-700">{d.reason}</span>
                        </div>
                    ))}
                </section>
            ) : null}

            {memo.red_lines.length ? (
                <section className="space-y-2">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-red-700"><Shield className="h-4 w-4" /> GARIS MERAH — Tidak Bisa Dikompromikan</h3>
                    {memo.red_lines.map((r, i) => (
                        <div key={i} className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                            <span className="font-medium">{r.description}</span> — {r.reason}
                        </div>
                    ))}
                </section>
            ) : null}

            <div className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium text-gray-900">Panduan Penutup</h3>
                    <CopyButton text={memo.closing_guidance} />
                </div>
                <p className="text-sm leading-6 text-gray-800">{memo.closing_guidance}</p>
            </div>
        </div>
    );
}

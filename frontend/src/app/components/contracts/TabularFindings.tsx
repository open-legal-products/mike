"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Flag, HelpCircle, MessageSquare, Pencil, Search, X } from "lucide-react";
import { postContractFeedbackBulk } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { RuleRefButton } from "@/app/components/playbook/PlaybookRuleDrawer";
import {
    ANNOTATION_TYPE_LABEL,
    SEVERITY_RANK,
    bulkDismissAction,
    bulkValidAction,
    statusForAnnotation,
    type AnnotationStatus,
    type AnnotationType,
    type FindingAnnotation,
} from "./findingAnnotations";
import type { ReviewFeedbackRow } from "./reviewTypes";
import { PRIORITY_LABEL, SEVERITY_COLOR } from "./reviewLabels";

// Tabel tab (Janus TabularReviewTab): every finding as a sortable, filterable
// row with multi-select bulk actions. Rows still "Belum ditinjau" can be
// bulk-confirmed or bulk-dismissed; dismissing requires a written reason,
// which the backend enforces for dismiss / reject / skip.

type TypeFilter = "all" | AnnotationType;
type StatusFilter = "all" | AnnotationStatus;
type SortKey = "position" | "severity" | "type" | "id" | "clause";

const TYPE_ICON: Record<AnnotationType, { Icon: typeof Flag; tone: string }> = {
    red_flag: { Icon: Flag, tone: "text-red-600" },
    revision: { Icon: Pencil, tone: "text-blue-600" },
    clarification: { Icon: HelpCircle, tone: "text-amber-600" },
    yellow_flag: { Icon: AlertTriangle, tone: "text-amber-600" },
    positive: { Icon: CheckCircle2, tone: "text-emerald-600" },
    manual: { Icon: MessageSquare, tone: "text-purple-600" },
};

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
    { key: "all", label: "Semua" },
    { key: "red_flag", label: "Tanda Bahaya" },
    { key: "revision", label: "Saran Revisi" },
    { key: "clarification", label: "Klarifikasi" },
    { key: "yellow_flag", label: "Peringatan" },
    { key: "positive", label: "Positif" },
    { key: "manual", label: "Komentar" },
];

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
    { key: "all", label: "Semua status" },
    { key: "pending", label: "Belum ditinjau" },
    { key: "reviewed", label: "Ditinjau" },
    { key: "dismissed", label: "Diabaikan" },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: "position", label: "Posisi di dokumen" },
    { key: "severity", label: "Tingkat" },
    { key: "type", label: "Tipe" },
    { key: "id", label: "ID" },
    { key: "clause", label: "Klausul" },
];

export function severityLabel(severity: string | undefined): string | null {
    if (!severity) return null;
    return PRIORITY_LABEL[severity] ?? severity;
}

function statusBadge(status: AnnotationStatus) {
    if (status === "pending") return <span className="text-xs text-gray-500">Belum ditinjau</span>;
    if (status === "reviewed") {
        return (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                <Check className="h-3 w-3" /> Ditinjau
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-xs text-gray-500">
            <X className="h-3 w-3" /> Diabaikan
        </span>
    );
}

export interface TabularFindingsProps {
    reviewId: string;
    annotations: FindingAnnotation[];
    onLocate: (text: string) => void;
    onFeedbackSaved: (rows: ReviewFeedbackRow[]) => void;
}

export function TabularFindings({ reviewId, annotations, onLocate, onFeedbackSaved }: TabularFindingsProps) {
    const [query, setQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    const [sortKey, setSortKey] = useState<SortKey>("position");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [dismissing, setDismissing] = useState(false);
    const [rationale, setRationale] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const sorted = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = annotations.filter((a) => {
            if (typeFilter !== "all" && a.type !== typeFilter) return false;
            if (statusFilter !== "all" && statusForAnnotation(a) !== statusFilter) return false;
            if (!q) return true;
            return `${a.id} ${a.clause} ${a.summary} ${a.severity ?? ""}`.toLowerCase().includes(q);
        });
        list.sort((a, b) => {
            switch (sortKey) {
                case "severity":
                    return (SEVERITY_RANK[a.severity ?? ""] ?? 99) - (SEVERITY_RANK[b.severity ?? ""] ?? 99);
                case "type":
                    return a.type.localeCompare(b.type);
                case "id":
                    return a.id.localeCompare(b.id, undefined, { numeric: true });
                case "clause":
                    return a.clause.localeCompare(b.clause, undefined, { numeric: true });
                default:
                    return 0; // buildAnnotations already sorts by position
            }
        });
        return list;
    }, [annotations, query, typeFilter, statusFilter, sortKey]);

    const counts = useMemo(() => {
        const c = { pending: 0, reviewed: 0, dismissed: 0 };
        for (const a of annotations) c[statusForAnnotation(a)] += 1;
        return c;
    }, [annotations]);

    // Only pending rows are selectable: feedback is one row per finding, and
    // re-acting on a reviewed finding would create a duplicate.
    const selectableKeys = useMemo(() => sorted.filter((a) => statusForAnnotation(a) === "pending").map((a) => a.key), [sorted]);
    const allSelected = selectableKeys.length > 0 && selectableKeys.every((k) => selected.has(k));

    const toggleRow = (key: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const toggleAll = () =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (allSelected) selectableKeys.forEach((k) => next.delete(k));
            else selectableKeys.forEach((k) => next.add(k));
            return next;
        });

    const clearSelection = () => {
        setSelected(new Set());
        setDismissing(false);
        setRationale("");
    };

    const bulkAct = async (kind: "valid" | "dismiss") => {
        const map = kind === "valid" ? bulkValidAction : bulkDismissAction;
        const targets = annotations.filter((a) => selected.has(a.key) && statusForAnnotation(a) === "pending" && map(a.type) !== null);
        const skipped = selected.size - targets.length;
        if (targets.length === 0) {
            setMessage("Tidak ada temuan yang dapat ditindaklanjuti untuk aksi ini.");
            return;
        }
        setBusy(true);
        setMessage(null);
        try {
            const rows = await postContractFeedbackBulk(
                reviewId,
                targets.map((a) => ({
                    finding_type: a.type,
                    finding_id: a.id,
                    action: map(a.type) as string,
                    original_severity: a.severity ?? null,
                    rationale: kind === "dismiss" ? rationale.trim() : null,
                })),
            );
            onFeedbackSaved(rows);
            setMessage(
                `${targets.length} temuan ${kind === "valid" ? "ditandai valid" : "diabaikan"}` +
                    (skipped > 0 ? `, ${skipped} dilewati (tidak sesuai aksi).` : "."),
            );
            clearSelection();
        } catch (e) {
            setMessage(userFacingApiError(e, "Gagal menyimpan umpan balik."));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                <span>
                    <span className="font-semibold text-gray-900">{annotations.length}</span> temuan · {counts.pending} belum ditinjau ·{" "}
                    <span className="text-emerald-700">{counts.reviewed} ditinjau</span>
                    {counts.dismissed ? <> · {counts.dismissed} diabaikan</> : null}
                </span>
                <label className="relative ml-auto block w-full max-w-[220px]">
                    <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-gray-400" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Cari klausul, ID, isi temuan..."
                        aria-label="Cari temuan"
                        className="h-8 w-full rounded-lg border border-gray-200 bg-white pl-7 pr-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
                    />
                </label>
            </div>

            <div className="flex flex-wrap items-center gap-1">
                {TYPE_FILTERS.map((f) => (
                    <FilterChip key={f.key} active={typeFilter === f.key} onClick={() => setTypeFilter(f.key)}>
                        {f.label}
                    </FilterChip>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-1">
                {STATUS_FILTERS.map((f) => (
                    <FilterChip key={f.key} active={statusFilter === f.key} onClick={() => setStatusFilter(f.key)}>
                        {f.label}
                    </FilterChip>
                ))}
                <label className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500">
                    Urutkan
                    <select
                        aria-label="Urutkan temuan"
                        value={sortKey}
                        onChange={(e) => setSortKey(e.target.value as SortKey)}
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-800"
                    >
                        {SORT_OPTIONS.map((o) => (
                            <option key={o.key} value={o.key}>{o.label}</option>
                        ))}
                    </select>
                </label>
            </div>

            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                <table className="w-full table-fixed border-collapse text-left">
                    <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                        <tr>
                            <th className="w-8 px-2 py-2">
                                <input
                                    type="checkbox"
                                    aria-label="Pilih semua temuan yang masih bisa ditindaklanjuti"
                                    checked={allSelected}
                                    disabled={selectableKeys.length === 0}
                                    onChange={toggleAll}
                                />
                            </th>
                            <th className="px-2 py-2">Temuan</th>
                            <th className="w-[92px] px-2 py-2">Tingkat</th>
                            <th className="w-[96px] px-2 py-2">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((a) => {
                            const { Icon, tone } = TYPE_ICON[a.type];
                            const status = statusForAnnotation(a);
                            const checked = selected.has(a.key);
                            const canLocate = a.highlightText.length >= 5;
                            return (
                                <tr
                                    key={a.key}
                                    data-testid={`row-${a.key}`}
                                    aria-selected={checked}
                                    className={`border-t border-gray-100 align-top ${status === "dismissed" ? "opacity-60" : ""} ${checked ? "bg-blue-50/40" : "hover:bg-gray-50"}`}
                                >
                                    <td className="px-2 py-2">
                                        <input
                                            type="checkbox"
                                            aria-label={`Pilih ${a.id}`}
                                            checked={checked}
                                            disabled={status !== "pending"}
                                            onChange={() => toggleRow(a.key)}
                                        />
                                    </td>
                                    <td className="px-2 py-2">
                                        <div className="flex items-center gap-1.5 text-xs text-gray-500">
                                            <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
                                            <span>{ANNOTATION_TYPE_LABEL[a.type]}</span>
                                            {a.type !== "manual" ? <span className="font-mono text-[11px] text-gray-400">{a.id}</span> : null}
                                            {a.clause !== "—" ? <span className="truncate text-gray-400">· {a.clause}</span> : null}
                                        </div>
                                        <button
                                            type="button"
                                            disabled={!canLocate}
                                            onClick={() => canLocate && onLocate(a.highlightText)}
                                            title={canLocate ? "Lihat di dokumen" : undefined}
                                            className="mt-0.5 line-clamp-2 text-left text-[13px] leading-snug text-gray-900 disabled:cursor-default enabled:hover:underline"
                                        >
                                            {a.summary}
                                        </button>
                                        {a.playbookRule ? (
                                            <div className="mt-1 flex items-center gap-1 text-[11px] text-gray-400">
                                                Playbook: <RuleRefButton ruleNumber={a.playbookRule} />
                                            </div>
                                        ) : null}
                                    </td>
                                    <td className="px-2 py-2">
                                        {a.severity ? (
                                            <span
                                                className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium"
                                                style={{ color: SEVERITY_COLOR[a.severity] ?? "#6B7280", borderColor: SEVERITY_COLOR[a.severity] ?? "#D1D5DB" }}
                                            >
                                                {severityLabel(a.severity)}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td className="px-2 py-2">{statusBadge(status)}</td>
                                </tr>
                            );
                        })}
                        {sorted.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-3 py-10 text-center text-xs text-gray-500">
                                    Tidak ada temuan untuk filter ini.
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>

            {message ? <p className="text-xs text-gray-600" role="status">{message}</p> : null}

            {selected.size > 0 ? (
                <div className="sticky bottom-0 z-10 rounded-2xl border border-gray-200 bg-white p-3 shadow-lg" data-testid="bulk-bar">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs">
                            <span className="font-semibold">{selected.size}</span> terpilih
                        </span>
                        {!dismissing ? (
                            <>
                                <PillButtonUI tone="white" size="xs" onClick={() => void bulkAct("valid")} loading={busy} disabled={busy}>
                                    <Check className="mr-1 h-3 w-3" /> Tandai valid
                                </PillButtonUI>
                                <PillButtonUI tone="white" size="xs" onClick={() => setDismissing(true)} disabled={busy}>
                                    <X className="mr-1 h-3 w-3" /> Abaikan
                                </PillButtonUI>
                            </>
                        ) : null}
                        <button type="button" onClick={clearSelection} disabled={busy} className="ml-auto text-xs text-gray-500 hover:text-gray-800">
                            Batalkan
                        </button>
                    </div>
                    {dismissing ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                                value={rationale}
                                onChange={(e) => setRationale(e.target.value)}
                                placeholder="Alasan mengabaikan (wajib)"
                                aria-label="Alasan mengabaikan"
                                className="h-8 min-w-0 flex-1 rounded-lg border border-gray-200 px-2 text-xs focus:border-gray-400 focus:outline-none"
                            />
                            <PillButtonUI tone="danger" size="xs" onClick={() => void bulkAct("dismiss")} loading={busy} disabled={busy || !rationale.trim()}>
                                Abaikan {selected.size} temuan
                            </PillButtonUI>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`rounded-full px-2.5 py-1 text-xs ${active ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"}`}
        >
            {children}
        </button>
    );
}

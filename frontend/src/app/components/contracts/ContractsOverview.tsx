"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Plus, Search, Trash2 } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    deleteContract,
    getMe,
    listContracts,
    type MeInfo,
} from "@/app/lib/mikeApi";
import {
    computeReviewStats,
    differenceInDays,
    filterReviews,
    REC_COLOR,
    REC_LABEL,
    RISK_DOT,
    RISK_LABEL,
    RISK_OPTIONS,
    STATUS_LABEL,
    STATUS_OPTIONS,
    type ReviewRow,
} from "@/app/components/contracts/reviewHelpers";

const selectClass =
    "h-9 rounded-xl border border-white/70 bg-white/80 px-3 text-sm text-gray-700 shadow-sm outline-none focus:border-gray-300";

function StatCard({
    label,
    value,
    sub,
    valueColor,
}: {
    label: string;
    value: number;
    sub?: string;
    valueColor?: string;
}) {
    return (
        <div className="rounded-2xl border border-white/70 bg-white p-4 shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
            <div className="text-xs font-medium text-gray-500">{label}</div>
            <div
                className="mt-1 text-2xl font-medium font-serif"
                style={{ color: valueColor ?? "#111827" }}
            >
                {value}
            </div>
            {sub ? <div className="mt-0.5 text-xs text-gray-400">{sub}</div> : null}
        </div>
    );
}

export function ContractsOverview() {
    const router = useRouter();
    const { user, isAuthenticated, authLoading } = useAuth();

    const [reviews, setReviews] = useState<ReviewRow[]>([]);
    const [me, setMe] = useState<MeInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [filterRisk, setFilterRisk] = useState("all");
    const [filterStatus, setFilterStatus] = useState("all");

    // Fresh "now" per mount — stable across renders (avoids re-computing the 60-day window every render).
    const [now] = useState(() => new Date());

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        Promise.all([listContracts(), getMe().catch(() => null)])
            .then(([rows, meInfo]) => {
                if (cancelled) return;
                setReviews(rows);
                setMe(meInfo);
            })
            .catch(() => {
                if (!cancelled) setReviews([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, user?.id]);

    const stats = useMemo(() => computeReviewStats(reviews, now), [reviews, now]);
    const filtered = useMemo(
        () => filterReviews(reviews, { search, risk: filterRisk, status: filterStatus }),
        [reviews, search, filterRisk, filterStatus],
    );

    const monthName = now.toLocaleDateString("id-ID", { month: "long", year: "numeric" });
    const canDelete = Boolean(me?.isAdmin);

    async function handleDelete(e: React.MouseEvent, id: string, title: string | null) {
        e.stopPropagation();
        if (!window.confirm(`Hapus tinjauan "${title ?? ""}"? Tindakan ini tidak dapat dibatalkan.`))
            return;
        try {
            await deleteContract(id);
            setReviews((prev) => prev.filter((r) => r.id !== id));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            alert("Gagal menghapus: " + message);
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                <div className="mx-auto w-full max-w-6xl">
                    {/* Header */}
                    <div className="flex items-end justify-between gap-4">
                        <div>
                            <div className="text-xs font-medium uppercase tracking-wide text-gray-400">
                                Dasbor
                            </div>
                            <h1 className="mt-1 text-2xl font-medium font-serif text-gray-900">
                                Tinjauan Kontrak
                            </h1>
                        </div>
                        <button
                            onClick={() => router.push("/contracts/new")}
                            className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
                        >
                            <Plus className="h-4 w-4" />
                            Tinjauan Baru
                        </button>
                    </div>

                    {/* Stat cards */}
                    <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <StatCard label="Total Tinjauan" value={reviews.length} />
                        <StatCard label="Bulan Ini" value={stats.thisMonth.length} sub={monthName} />
                        <StatCard
                            label="Risiko Kritis"
                            value={stats.criticalCount}
                            valueColor={stats.criticalCount > 0 ? "#DC2626" : undefined}
                        />
                        <StatCard
                            label="Segera Berakhir"
                            value={stats.expiringSoon.length}
                            sub="dalam 60 hari"
                        />
                    </div>

                    {/* Expiring banner */}
                    {stats.expiringSoon.length > 0 && (
                        <div
                            className="mt-4 rounded-2xl p-4"
                            style={{ border: "1px solid #FDE68A", background: "#FFFBEB" }}
                        >
                            <div className="flex items-center gap-2 text-sm font-medium text-amber-800">
                                <AlertTriangle className="h-4 w-4" />
                                {stats.expiringSoon.length} kontrak berakhir dalam 60 hari
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                                {stats.expiringSoon.slice(0, 8).map((r) => {
                                    const days = differenceInDays(new Date(r.expiry_date!), now);
                                    return (
                                        <button
                                            key={r.id}
                                            onClick={() => router.push(`/contracts/${r.id}`)}
                                            className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-white px-3 py-1 text-xs text-amber-900 hover:bg-amber-50"
                                        >
                                            <span className="max-w-[180px] truncate">{r.title}</span>
                                            <span className="text-amber-500">{days}h</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Filters */}
                    <div className="mt-5 flex flex-wrap items-center gap-2">
                        <div className="relative flex-1 min-w-[220px]">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Cari kontrak..."
                                className="h-9 w-full rounded-xl border border-white/70 bg-white/80 pl-9 pr-3 text-sm text-gray-700 shadow-sm outline-none focus:border-gray-300"
                            />
                        </div>
                        <select
                            value={filterRisk}
                            onChange={(e) => setFilterRisk(e.target.value)}
                            className={selectClass}
                        >
                            {RISK_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                        <select
                            value={filterStatus}
                            onChange={(e) => setFilterStatus(e.target.value)}
                            className={selectClass}
                        >
                            {STATUS_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Table */}
                    <div className="mt-4 overflow-hidden rounded-2xl border border-white/70 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-gray-100 text-left text-[11px] font-medium uppercase tracking-wide text-gray-400">
                                        <th className="px-4 py-3">Judul</th>
                                        <th className="px-4 py-3">Klien</th>
                                        <th className="px-4 py-3">Jenis</th>
                                        <th className="px-4 py-3">Risiko</th>
                                        <th className="px-4 py-3">Rekomendasi</th>
                                        <th className="px-4 py-3">Status</th>
                                        <th className="px-4 py-3">Diunggah Oleh</th>
                                        <th className="px-4 py-3">Tanggal</th>
                                        {canDelete && <th className="w-10 px-2 py-3" />}
                                    </tr>
                                </thead>
                                <tbody>
                                    {loading ? (
                                        <tr>
                                            <td colSpan={canDelete ? 9 : 8} className="px-4 py-10 text-center text-gray-400">
                                                Memuat...
                                            </td>
                                        </tr>
                                    ) : filtered.length === 0 ? (
                                        <tr>
                                            <td colSpan={canDelete ? 9 : 8} className="px-4 py-10 text-center text-gray-400">
                                                {reviews.length === 0
                                                    ? "Belum ada tinjauan. Unggah kontrak pertama Anda untuk memulai."
                                                    : "Tidak ada tinjauan ditemukan."}
                                            </td>
                                        </tr>
                                    ) : (
                                        filtered.map((r) => (
                                            <tr
                                                key={r.id}
                                                onClick={() => router.push(`/contracts/${r.id}`)}
                                                className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/60"
                                            >
                                                <td className="max-w-[280px] truncate px-4 py-3 font-medium text-gray-900">
                                                    {r.title}
                                                </td>
                                                <td className="max-w-[180px] truncate px-4 py-3 text-gray-500">
                                                    {r.client_name}
                                                </td>
                                                <td className="px-4 py-3">
                                                    {r.document_type ? (
                                                        <span className="rounded-md border border-gray-200 px-2 py-0.5 text-xs text-gray-600">
                                                            {r.document_type}
                                                        </span>
                                                    ) : (
                                                        "—"
                                                    )}
                                                </td>
                                                <td className="px-4 py-3">
                                                    {r.risk_level ? (
                                                        <span className="inline-flex items-center gap-1.5">
                                                            <span
                                                                className="h-2 w-2 rounded-full"
                                                                style={{ background: RISK_DOT[r.risk_level] ?? "#9CA3AF" }}
                                                            />
                                                            {RISK_LABEL[r.risk_level] ?? r.risk_level}
                                                        </span>
                                                    ) : (
                                                        "—"
                                                    )}
                                                </td>
                                                <td className="px-4 py-3">
                                                    {r.recommendation ? (
                                                        <span style={{ color: REC_COLOR[r.recommendation] ?? "#6B7280" }}>
                                                            {REC_LABEL[r.recommendation] ?? r.recommendation}
                                                        </span>
                                                    ) : (
                                                        "—"
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-gray-600">
                                                    {r.status ? STATUS_LABEL[r.status] ?? r.status : "—"}
                                                </td>
                                                <td className="px-4 py-3 text-gray-500" title={r.uploader_email ?? undefined}>
                                                    {r.uploader_email ? r.uploader_email.split("@")[0] : "—"}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                                                    {new Date(r.created_at).toLocaleDateString("id-ID", {
                                                        day: "numeric",
                                                        month: "short",
                                                    })}
                                                </td>
                                                {canDelete && (
                                                    <td className="px-2 py-3">
                                                        <button
                                                            onClick={(e) => handleDelete(e, r.id, r.title)}
                                                            title="Hapus tinjauan"
                                                            className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    </td>
                                                )}
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

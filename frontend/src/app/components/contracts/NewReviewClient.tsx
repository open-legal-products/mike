"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, FileText, X } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    createReview,
    getReviewStatus,
    listContracts,
    uploadContractFile,
} from "@/app/lib/mikeApi";
import {
    DOCUMENT_TYPES,
    PROCESSING_STEPS,
    REVIEW_FOCUS_OPTIONS,
    RISK_LABEL,
    computeAvgRisk,
    type ReviewRow,
} from "@/app/components/contracts/reviewHelpers";

const MAX_BYTES = 25 * 1024 * 1024;

export function NewReviewClient() {
    const router = useRouter();
    const { user, isAuthenticated, authLoading } = useAuth();

    const [reviews, setReviews] = useState<ReviewRow[]>([]);
    const [file, setFile] = useState<File | null>(null);
    const [extracting, setExtracting] = useState(false);
    const [contractText, setContractText] = useState("");
    const [contractHtml, setContractHtml] = useState<string | null>(null);
    const [filename, setFilename] = useState<string | null>(null);
    const [docxKey, setDocxKey] = useState<string | null>(null);
    const [fileError, setFileError] = useState<string | null>(null);
    const [dragOver, setDragOver] = useState(false);

    const [clientName, setClientName] = useState("");
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [docType, setDocType] = useState("PKS");
    const [projectContext, setProjectContext] = useState("");
    const [reviewFocus, setReviewFocus] = useState<string[]>(["Menyeluruh"]);

    const [submitting, setSubmitting] = useState(false);
    const [currentStep, setCurrentStep] = useState(0);
    const [progress, setProgress] = useState(0);
    const [submitError, setSubmitError] = useState<string | null>(null);

    const stepTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        listContracts()
            .then((rows) => !cancelled && setReviews(rows))
            .catch(() => !cancelled && setReviews([]));
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, user?.id]);

    // Clear timers + stop polling/nav on unmount.
    useEffect(() => {
        return () => {
            mountedRef.current = false;
            if (stepTimer.current) clearInterval(stepTimer.current);
            if (progressTimer.current) clearInterval(progressTimer.current);
            if (navTimer.current) clearTimeout(navTimer.current);
        };
    }, []);

    const clientNames = useMemo(
        () => [...new Set(reviews.map((r) => r.client_name).filter((v): v is string => Boolean(v)))],
        [reviews],
    );
    const filteredClients = useMemo(() => {
        const q = clientName.trim().toLowerCase();
        if (!q) return [];
        return clientNames.filter((n) => n.toLowerCase().includes(q) && n.toLowerCase() !== q).slice(0, 5);
    }, [clientNames, clientName]);

    const clientInfo = useMemo(() => {
        const trimmed = clientName.trim();
        if (!trimmed || !clientNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) return null;
        const prior = reviews.filter((r) => (r.client_name ?? "").toLowerCase() === trimmed.toLowerCase());
        if (prior.length === 0) return null;
        const avg = computeAvgRisk(prior);
        const lastDate = prior
            .map((r) => new Date(r.created_at))
            .sort((a, b) => b.getTime() - a.getTime())[0]
            .toLocaleDateString("id-ID", { month: "short", year: "numeric" });
        return { count: prior.length, avgRisk: avg, lastDate };
    }, [clientName, clientNames, reviews]);

    async function handleFile(f: File) {
        setFileError(null);
        if (f.name.split(".").pop()?.toLowerCase() !== "docx") {
            setFileError("Hanya file DOCX yang diperbolehkan.");
            return;
        }
        if (f.size > MAX_BYTES) {
            setFileError("Maksimum 25MB");
            return;
        }
        setFile(f);
        setExtracting(true);
        try {
            const res = await uploadContractFile(f);
            setContractText(res.contract_text);
            setContractHtml(res.contract_html);
            setFilename(res.filename);
            setDocxKey(res.docx_key ?? null);
        } catch (e) {
            setFileError(e instanceof Error ? e.message : "Ekstraksi gagal");
            setFile(null);
        } finally {
            setExtracting(false);
        }
    }

    function toggleFocus(opt: string) {
        setReviewFocus((prev) => {
            if (opt === "Menyeluruh") return ["Menyeluruh"];
            const without = prev.filter((x) => x !== "Menyeluruh");
            return without.includes(opt) ? without.filter((x) => x !== opt) : [...without, opt];
        });
    }

    const canSubmit = Boolean(file && contractText && clientName.trim() && !extracting && !submitting);

    function startTimers() {
        stepTimer.current = setInterval(() => {
            setCurrentStep((s) => Math.min(s + 1, PROCESSING_STEPS.length - 1));
        }, 4000);
        progressTimer.current = setInterval(() => {
            setProgress((p) => Math.min(p + 1, 90));
        }, 350);
    }
    function stopTimers() {
        if (stepTimer.current) clearInterval(stepTimer.current);
        if (progressTimer.current) clearInterval(progressTimer.current);
        stepTimer.current = null;
        progressTimer.current = null;
    }

    async function pollUntilDone(id: string) {
        // ~2.5 min budget (75 * 2s)
        for (let i = 0; i < 75; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (!mountedRef.current) return; // stop polling after unmount
            const st = await getReviewStatus(id);
            if (st.status === "ai_reviewed" || st.status === "clevel_reviewed") return;
            if (st.status === "failed") throw new Error("Analisis AI gagal. Silakan coba lagi.");
        }
        throw new Error("Waktu analisis habis. Silakan coba lagi.");
    }

    async function handleSubmit() {
        if (!canSubmit) return;
        setSubmitError(null);
        setSubmitting(true);
        setCurrentStep(0);
        setProgress(0);
        startTimers();
        try {
            const title = (filename ?? "Kontrak").replace(/\.docx$/i, "");
            const { id } = await createReview({
                title,
                client_name: clientName.trim(),
                document_type: docType,
                project_context: projectContext,
                review_focus: reviewFocus,
                contract_text: contractText,
                contract_html: contractHtml,
                contract_filename: filename,
                contract_docx_path: docxKey,
            });
            await pollUntilDone(id);
            stopTimers();
            if (!mountedRef.current) return;
            setProgress(100);
            setCurrentStep(PROCESSING_STEPS.length - 1);
            navTimer.current = setTimeout(() => {
                if (mountedRef.current) router.push("/contracts");
            }, 500);
        } catch (e) {
            stopTimers();
            if (!mountedRef.current) return;
            setSubmitError(e instanceof Error ? e.message : "Tinjauan gagal");
            setSubmitting(false);
        }
    }

    // ── Analyzing screen ──────────────────────────────────────────────────────
    if (submitting) {
        return (
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-6 py-10">
                <div className="mx-auto w-full max-w-2xl">
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-400">Tinjauan Baru</div>
                    <h1 className="mt-1 text-2xl font-medium font-serif text-gray-900">Menganalisis...</h1>
                    <div className="mt-6 space-y-3">
                        {PROCESSING_STEPS.map((step, i) => {
                            const done = i < currentStep;
                            const active = i === currentStep;
                            const barWidth = done ? 100 : active ? progress : 0;
                            const color = done ? "#16A34A" : "#111827";
                            return (
                                <div key={step}>
                                    <div className="flex items-center justify-between text-sm">
                                        <span style={{ color: done || active ? "#111827" : "#9CA3AF", fontWeight: done ? 500 : 400 }}>
                                            {step}
                                        </span>
                                        <span className="text-xs text-gray-400">{done ? "✓" : active ? "..." : ""}</span>
                                    </div>
                                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-gray-100">
                                        <div className="h-full rounded-full transition-all" style={{ width: `${barWidth}%`, background: color }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="mt-6 text-xs text-gray-400">Biasanya membutuhkan 30–90 detik</div>
                </div>
            </div>
        );
    }

    // ── Form screen ───────────────────────────────────────────────────────────
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-6 py-6">
            <div className="mx-auto w-full max-w-2xl">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-400">Tinjauan Baru</div>
                <h1 className="mt-1 text-2xl font-medium font-serif text-gray-900">
                    {file ? "Detail kontrak" : "Unggah kontrak"}
                </h1>

                {submitError && (
                    <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {submitError}
                    </div>
                )}

                {/* Dropzone */}
                <label
                    onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        const f = e.dataTransfer.files?.[0];
                        if (f) void handleFile(f);
                    }}
                    className={`mt-5 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
                        dragOver ? "border-gray-400 bg-gray-50" : "border-gray-200 bg-white"
                    }`}
                >
                    <input
                        type="file"
                        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        className="hidden"
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleFile(f);
                            // Reset so re-selecting the same file (after remove/fail) re-fires onChange.
                            e.target.value = "";
                        }}
                    />
                    {file ? (
                        <div className="flex items-center gap-3">
                            <FileText className="h-6 w-6 text-gray-500" />
                            <div className="text-left">
                                <div className="text-sm font-medium text-gray-900">{file.name}</div>
                                <div className="text-xs text-gray-400">
                                    {extracting ? "Mengekstrak..." : `${contractText.length.toLocaleString("id-ID")} karakter`}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    setFile(null);
                                    setContractText("");
                                    setContractHtml(null);
                                    setFilename(null);
                                    setDocxKey(null);
                                    setFileError(null);
                                }}
                                className="ml-2 rounded-md p-1 text-gray-400 hover:bg-gray-100"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    ) : (
                        <>
                            <Upload className="h-7 w-7 text-gray-400" />
                            <div className="mt-3 text-sm font-medium text-gray-700">Seret &amp; lepas file</div>
                            <div className="mt-0.5 text-xs text-gray-400">DOCX · maks. 25 MB</div>
                            <span className="mt-3 inline-flex rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white">
                                Pilih file
                            </span>
                        </>
                    )}
                </label>
                {fileError && <div className="mt-2 text-sm text-red-600">{fileError}</div>}
                <p className="mt-3 text-xs text-gray-400">
                    Varda akan meninjau kontrak berdasarkan aturan playbook dan mengidentifikasi risiko utama serta klausul bermasalah secara otomatis.
                </p>

                {/* Form fields */}
                <div className="mt-6 space-y-5">
                    <div className="relative">
                        <label className="text-sm font-medium text-gray-700">Nama Klien</label>
                        <input
                            value={clientName}
                            onChange={(e) => {
                                setClientName(e.target.value);
                                setShowSuggestions(true);
                            }}
                            onFocus={() => setShowSuggestions(true)}
                            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                            placeholder="PT ..."
                            className="mt-1 h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-400"
                        />
                        {showSuggestions && filteredClients.length > 0 && (
                            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
                                {filteredClients.map((n) => (
                                    <button
                                        key={n}
                                        type="button"
                                        onMouseDown={() => setClientName(n)}
                                        className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                                    >
                                        {n}
                                    </button>
                                ))}
                            </div>
                        )}
                        {clientInfo && (
                            <div className="mt-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                                {clientInfo.count} kontrak sebelumnya untuk klien ini. Rata-rata risiko:{" "}
                                {RISK_LABEL[clientInfo.avgRisk] ?? clientInfo.avgRisk} · Terakhir ditinjau: {clientInfo.lastDate}
                            </div>
                        )}
                    </div>

                    <div>
                        <label className="text-sm font-medium text-gray-700">Jenis Dokumen</label>
                        <select
                            value={docType}
                            onChange={(e) => setDocType(e.target.value)}
                            className="mt-1 h-10 w-full rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-gray-400"
                        >
                            {DOCUMENT_TYPES.map((d) => (
                                <option key={d.value} value={d.value}>
                                    {d.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="text-sm font-medium text-gray-700">Konteks tambahan</label>
                        <textarea
                            value={projectContext}
                            onChange={(e) => setProjectContext(e.target.value)}
                            rows={4}
                            placeholder="Detail proyek, rute, harga, kebutuhan suhu, kondisi khusus..."
                            className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400"
                        />
                    </div>

                    <div>
                        <label className="text-sm font-medium text-gray-700">Fokus tinjauan</label>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {REVIEW_FOCUS_OPTIONS.map((opt) => {
                                const on = reviewFocus.includes(opt);
                                return (
                                    <button
                                        key={opt}
                                        type="button"
                                        onClick={() => toggleFocus(opt)}
                                        className={`rounded-full border px-3 py-1 text-xs transition ${
                                            on
                                                ? "border-gray-900 bg-gray-900 text-white"
                                                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                                        }`}
                                    >
                                        {opt}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* Actions */}
                <div className="mt-8 flex items-center gap-3">
                    <button
                        onClick={() => void handleSubmit()}
                        disabled={!canSubmit}
                        className="rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {extracting ? "Mengekstrak..." : "Mulai Analisis AI"}
                    </button>
                    <button
                        onClick={() => router.push("/contracts")}
                        className="rounded-full px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700"
                    >
                        Batal
                    </button>
                </div>
            </div>
        </div>
    );
}

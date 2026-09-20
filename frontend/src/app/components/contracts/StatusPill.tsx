"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Clock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/app/components/ui/popover";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { patchContract, type ContractPatch } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";
import { differenceInDays } from "./reviewHelpers";

// Compact lifecycle pill (ported from Janus StatusPill): click → popover with the
// 8 stages as a checklist plus signing / expiry / renewal dates. Stage changes
// go through PATCH /contracts/:id, which also syncs the legacy `status`.

export const LIFECYCLE_STAGES = [
    { value: "draft", label: "Draf" },
    { value: "ai_review", label: "Tinjauan AI" },
    { value: "clevel_review", label: "Tinjauan C-Level" },
    { value: "negotiation", label: "Negosiasi" },
    { value: "client_redline", label: "Redline Klien" },
    { value: "final_review", label: "Tinjauan Akhir" },
    { value: "signed", label: "Ditandatangani" },
    { value: "active", label: "Aktif" },
] as const;

const HINT_KEY = "tinjau.statuspill.hint.dismissed";

export interface StatusPillReview {
    id: string;
    lifecycle_stage: string | null;
    signing_date: string | null;
    expiry_date: string | null;
    renewal_date: string | null;
}

export function StatusPill({
    review,
    onUpdate,
}: {
    review: StatusPillReview;
    onUpdate: (patch: ContractPatch) => void;
}) {
    const currentIdx = LIFECYCLE_STAGES.findIndex((s) => s.value === review.lifecycle_stage);
    const currentStage = currentIdx >= 0 ? LIFECYCLE_STAGES[currentIdx] : null;

    const [signingDate, setSigningDate] = useState(review.signing_date ?? "");
    const [expiryDate, setExpiryDate] = useState(review.expiry_date ?? "");
    const [renewalDate, setRenewalDate] = useState(review.renewal_date ?? "");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [showHint, setShowHint] = useState(false);

    useEffect(() => {
        try {
            setShowHint(window.localStorage.getItem(HINT_KEY) !== "1");
        } catch {
            setShowHint(false);
        }
    }, []);

    const dismissHint = () => {
        try {
            window.localStorage.setItem(HINT_KEY, "1");
        } catch {
            /* noop */
        }
        setShowHint(false);
    };

    const daysUntilExpiry = expiryDate ? differenceInDays(new Date(expiryDate), new Date()) : null;
    const isExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry <= 60 && daysUntilExpiry > 0;
    const isExpired = daysUntilExpiry !== null && daysUntilExpiry <= 0;
    const expiryWarn = review.lifecycle_stage === "active" && (isExpiringSoon || isExpired);

    const apply = async (patch: ContractPatch, successMessage: string) => {
        setBusy(true);
        setMessage(null);
        try {
            const saved = await patchContract(review.id, patch);
            onUpdate(saved);
            setMessage(successMessage);
        } catch {
            setMessage("Gagal menyimpan. Coba lagi.");
        } finally {
            setBusy(false);
        }
    };

    const updateStage = (stage: string) => {
        const label = LIFECYCLE_STAGES.find((s) => s.value === stage)?.label ?? stage;
        void apply({ lifecycle_stage: stage }, `Tahap diperbarui ke ${label}`);
    };

    const saveDates = () =>
        void apply(
            {
                signing_date: signingDate || null,
                expiry_date: expiryDate || null,
                renewal_date: renewalDate || null,
            },
            "Tanggal tersimpan",
        );

    return (
        <div className="relative">
            <Popover onOpenChange={(open) => open && dismissHint()}>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        className={cn(
                            "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium",
                            expiryWarn ? "border-red-500 text-red-600" : "border-gray-200 text-gray-800 hover:bg-gray-50",
                        )}
                        aria-label="Tahap kontrak"
                    >
                        {expiryWarn ? <AlertTriangle className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                        {currentStage?.label ?? "Status"}
                        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                    </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[360px] bg-white p-0">
                    <div className="border-b border-gray-100 p-3">
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Tahap kontrak</div>
                        <div className="space-y-0.5">
                            {LIFECYCLE_STAGES.map((stage, i) => {
                                const isActive = stage.value === review.lifecycle_stage;
                                const isPast = i < currentIdx;
                                return (
                                    <button
                                        key={stage.value}
                                        type="button"
                                        disabled={busy}
                                        onClick={() => updateStage(stage.value)}
                                        className={cn(
                                            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                                            isActive ? "bg-gray-900 font-medium text-white" : "text-gray-700 hover:bg-gray-100",
                                            !isActive && !isPast && "text-gray-400",
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "flex h-4 w-4 items-center justify-center rounded-full border",
                                                isActive ? "border-white" : isPast ? "border-gray-900 text-gray-900" : "border-gray-300",
                                            )}
                                        >
                                            {(isPast || isActive) && <Check className="h-2.5 w-2.5" />}
                                        </span>
                                        {stage.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="space-y-2 border-b border-gray-100 p-3">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Tanggal kontrak</div>
                        <DateRow label="Penandatanganan" value={signingDate} onChange={setSigningDate} />
                        <DateRow label="Berakhir" value={expiryDate} onChange={setExpiryDate} />
                        <DateRow label="Perpanjangan otomatis" value={renewalDate} onChange={setRenewalDate} />
                        <PillButtonUI tone="black" size="xs" className="w-full" onClick={saveDates} loading={busy}>
                            Simpan tanggal
                        </PillButtonUI>
                    </div>
                    {review.lifecycle_stage === "active" && expiryDate ? (
                        <div className="flex items-center gap-2 p-3 text-xs">
                            <Clock className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                            <span className="font-medium">
                                {isExpired ? "Kontrak telah berakhir" : `${daysUntilExpiry} hari menuju berakhir`}
                            </span>
                            {isExpiringSoon || isExpired ? (
                                <span className="ml-auto rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                                    {isExpired ? "BERAKHIR" : "Segera"}
                                </span>
                            ) : null}
                        </div>
                    ) : null}
                    {message ? <div className="px-3 py-2 text-xs text-gray-600" role="status">{message}</div> : null}
                </PopoverContent>
            </Popover>
            {showHint ? (
                <button
                    type="button"
                    onClick={dismissHint}
                    aria-label="Tutup petunjuk"
                    className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-500 shadow-sm hover:bg-gray-50"
                >
                    Klik untuk ubah tahap →
                </button>
            ) : null}
        </div>
    );
}

function DateRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
    return (
        <label className="flex items-center gap-2 text-xs text-gray-500">
            <span className="w-[140px]">{label}</span>
            <input
                type="date"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="h-8 flex-1 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-800"
            />
        </label>
    );
}

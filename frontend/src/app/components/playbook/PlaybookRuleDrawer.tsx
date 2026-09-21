"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, BookOpen, Shield, X } from "lucide-react";
import { getMe, listPlaybookRules, updatePlaybookRule } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { RuleForm, type RuleFormValue } from "./RuleForm";
import { SEVERITY_TONE, parseThresholds, type PlaybookRule } from "./playbookTypes";

// Janus PlaybookRuleDrawer: a finding's "RULE 6" reference slides the rule in
// from the right. Admins edit in place (the next review picks it up, no
// redeploy); everyone else reads. Rules are fetched once per workspace mount.

interface DrawerCtx {
    openRule: (ruleNumber: string) => void;
}

const Ctx = createContext<DrawerCtx | null>(null);

export function PlaybookDrawerProvider({ children }: { children: ReactNode }) {
    const [openRuleNumber, setOpenRuleNumber] = useState<string | null>(null);
    const [rules, setRules] = useState<PlaybookRule[] | null>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);

    const openRule = useCallback((ruleNumber: string) => setOpenRuleNumber(ruleNumber), []);
    const close = useCallback(() => setOpenRuleNumber(null), []);

    // Lazy: the first open triggers one load of rules + role.
    useEffect(() => {
        if (openRuleNumber === null || loaded) return;
        let cancelled = false;
        Promise.all([listPlaybookRules(), getMe().catch(() => null)])
            .then(([rows, me]) => {
                if (cancelled) return;
                setRules(rows);
                setIsAdmin(Boolean(me?.isAdmin));
                setLoaded(true);
            })
            .catch(() => {
                if (!cancelled) setLoadError("Aturan playbook tidak dapat dimuat.");
            });
        return () => {
            cancelled = true;
        };
    }, [openRuleNumber, loaded]);

    useEffect(() => {
        if (openRuleNumber === null) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") close();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [openRuleNumber, close]);

    const ctx = useMemo(() => ({ openRule }), [openRule]);
    const rule = openRuleNumber && rules ? rules.find((r) => r.rule_number === openRuleNumber) ?? null : null;

    return (
        <Ctx.Provider value={ctx}>
            {children}
            {openRuleNumber !== null ? (
                <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
                    <button type="button" aria-label="Tutup" onClick={close} className="absolute inset-0 bg-black/20" />
                    <aside role="dialog" aria-label={`Aturan ${openRuleNumber}`} className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto bg-white p-6 shadow-2xl">
                        <button type="button" onClick={close} aria-label="Tutup panel" className="absolute right-4 top-4 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800">
                            <X className="h-4 w-4" />
                        </button>
                        {loadError ? (
                            <p className="text-sm text-red-600">{loadError}</p>
                        ) : !rules ? (
                            <p className="inline-flex items-center gap-2 text-sm text-gray-500"><BookOpen className="h-4 w-4" /> Memuat aturan...</p>
                        ) : !rule ? (
                            <div>
                                <h2 className="inline-flex items-center gap-2 text-base font-medium text-gray-900"><AlertTriangle className="h-4 w-4 text-amber-600" /> Aturan tidak ditemukan</h2>
                                <p className="mt-2 text-sm text-gray-600">Aturan <span className="font-mono">{openRuleNumber}</span> tidak ada di playbook. AI mungkin merujuk ke aturan yang dihapus atau format yang berbeda.</p>
                            </div>
                        ) : (
                            <RuleDrawerBody
                                rule={rule}
                                isAdmin={isAdmin}
                                onSaved={(saved) => {
                                    setRules((prev) => (prev ?? []).map((r) => (r.id === saved.id ? saved : r)));
                                    close();
                                }}
                                onClose={close}
                            />
                        )}
                    </aside>
                </div>
            ) : null}
        </Ctx.Provider>
    );
}

function RuleDrawerBody({ rule, isAdmin, onSaved, onClose }: { rule: PlaybookRule; isAdmin: boolean; onSaved: (r: PlaybookRule) => void; onClose: () => void }) {
    const [form, setForm] = useState<RuleFormValue>({
        rule_number: rule.rule_number,
        title: rule.title,
        description: rule.description,
        thresholdsText: JSON.stringify(rule.thresholds ?? {}, null, 2),
        severity: rule.severity,
        is_active: rule.is_active,
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const tone = SEVERITY_TONE[rule.severity] ?? SEVERITY_TONE.MEDIUM;

    const save = async () => {
        const thresholds = parseThresholds(form.thresholdsText);
        if (!thresholds) {
            setError("JSON thresholds tidak valid.");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            onSaved(await updatePlaybookRule(rule.id, { title: form.title.trim(), description: form.description.trim(), severity: form.severity, is_active: form.is_active, thresholds }));
        } catch (e) {
            setError(userFacingApiError(e, "Gagal menyimpan."));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-gray-200 px-2 py-0.5 font-mono text-xs text-gray-700">{rule.rule_number}</span>
                <span className="rounded px-2 py-0.5 text-[11px] font-semibold" style={{ background: tone.bg, color: tone.color }}>{rule.severity}</span>
                {!form.is_active ? <span className="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500">Nonaktif</span> : null}
            </div>
            <div>
                <h2 className="text-base font-medium text-gray-900">{isAdmin ? "Ubah Aturan Playbook" : "Lihat Aturan Playbook"}</h2>
                <p className="mt-1 text-sm text-gray-500">
                    {isAdmin ? "Perubahan langsung berlaku untuk tinjauan AI berikutnya. Tidak perlu redeploy." : "Hanya administrator yang dapat mengubah aturan. Hubungi C-Level untuk mengusulkan perubahan."}
                </p>
            </div>
            <RuleForm value={form} onChange={setForm} disabled={!isAdmin || saving} showRuleNumber={false} showActive />
            {!isAdmin ? (
                <p className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
                    <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Hanya administrator yang dapat mengubah aturan. Tutup panel ini untuk kembali ke tinjauan.
                </p>
            ) : null}
            <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} disabled={saving} className="rounded-full border border-gray-200 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50">Batalkan</button>
                {isAdmin ? (
                    <PillButtonUI tone="black" size="sm" onClick={() => void save()} loading={saving} disabled={saving || !form.title.trim() || !form.description.trim()}>
                        Simpan
                    </PillButtonUI>
                ) : null}
                {error ? <span className="text-xs text-red-600">{error}</span> : null}
            </div>
        </div>
    );
}

/** Clickable rule reference. Outside a provider it degrades to plain text. */
export function RuleRefButton({ ruleNumber, className }: { ruleNumber: string; className?: string }) {
    const ctx = useContext(Ctx);
    if (!ctx) return <span className={className}>{ruleNumber}</span>;
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                ctx.openRule(ruleNumber);
            }}
            aria-label={`Buka aturan ${ruleNumber}`}
            className={`inline-flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[11px] text-gray-600 hover:bg-gray-100 hover:text-gray-900 ${className ?? ""}`}
        >
            <BookOpen className="h-3 w-3" /> {ruleNumber}
        </button>
    );
}

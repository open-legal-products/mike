"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Pencil, Plus, Power, Shield } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { createPlaybookRule, getMe, listPlaybookRules, updatePlaybookRule } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { Modal } from "@/app/components/modals/Modal";
import { EMPTY_RULE_FORM, RuleForm, type RuleFormValue } from "./RuleForm";
import { SEVERITY_TONE, parseThresholds, type PlaybookRule } from "./playbookTypes";

// /playbook (Janus "Aturan Playbook"): the rule set every AI review is scored
// against. Any signed-in user can read; admins add, edit and toggle rules.
// Edits reach the next review immediately because runReview sends the active
// rules with every call.

function toForm(rule: PlaybookRule): RuleFormValue {
    return {
        rule_number: rule.rule_number,
        title: rule.title,
        description: rule.description,
        thresholdsText: JSON.stringify(rule.thresholds ?? {}, null, 2),
        severity: rule.severity,
        is_active: rule.is_active,
    };
}

export function PlaybookAdmin() {
    const { isAuthenticated, authLoading } = useAuth();
    const [rules, setRules] = useState<PlaybookRule[] | null>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [editor, setEditor] = useState<{ rule: PlaybookRule | null; form: RuleFormValue } | null>(null);
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [togglingId, setTogglingId] = useState<string | null>(null);

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        let cancelled = false;
        Promise.all([listPlaybookRules(), getMe().catch(() => null)])
            .then(([rows, me]) => {
                if (cancelled) return;
                setRules(rows);
                setIsAdmin(Boolean(me?.isAdmin));
            })
            .catch(() => {
                if (!cancelled) setLoadError("Aturan playbook tidak dapat dimuat. Coba lagi.");
            });
        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated]);

    const activeCount = useMemo(() => (rules ?? []).filter((r) => r.is_active).length, [rules]);

    const upsertLocal = useCallback((saved: PlaybookRule) => {
        setRules((prev) => {
            const list = prev ?? [];
            const next = list.some((r) => r.id === saved.id) ? list.map((r) => (r.id === saved.id ? saved : r)) : [...list, saved];
            return next.sort((a, b) => a.rule_number.localeCompare(b.rule_number, undefined, { numeric: true }));
        });
    }, []);

    const save = async () => {
        if (!editor) return;
        const thresholds = parseThresholds(editor.form.thresholdsText);
        if (!thresholds) {
            setFormError("JSON thresholds tidak valid.");
            return;
        }
        setSaving(true);
        setFormError(null);
        const payload = {
            rule_number: editor.form.rule_number.trim(),
            title: editor.form.title.trim(),
            description: editor.form.description.trim(),
            thresholds,
            severity: editor.form.severity,
        };
        try {
            const saved = editor.rule ? await updatePlaybookRule(editor.rule.id, payload) : await createPlaybookRule(payload);
            upsertLocal(saved);
            setNotice(editor.rule ? "Aturan diperbarui. Tinjauan berikutnya akan menggunakan versi yang baru." : "Aturan dibuat.");
            setEditor(null);
        } catch (e) {
            setFormError(userFacingApiError(e, editor.rule ? "Gagal memperbarui aturan." : "Gagal membuat aturan."));
        } finally {
            setSaving(false);
        }
    };

    const toggleActive = async (rule: PlaybookRule) => {
        setTogglingId(rule.id);
        setNotice(null);
        try {
            upsertLocal(await updatePlaybookRule(rule.id, { is_active: !rule.is_active }));
        } catch (e) {
            setNotice(userFacingApiError(e, "Gagal mengubah status aturan."));
        } finally {
            setTogglingId(null);
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
                <div className="mx-auto w-full max-w-5xl">
                    <div className="flex items-end justify-between gap-4">
                        <div>
                            <div className="text-xs font-medium uppercase tracking-wide text-gray-400">Aturan Playbook</div>
                            <h1 className="mt-1 font-serif text-2xl font-medium text-gray-900">
                                {rules ? `${activeCount} Aturan Aktif` : "Memuat..."}
                            </h1>
                        </div>
                        {isAdmin ? (
                            <button
                                type="button"
                                onClick={() => { setFormError(null); setEditor({ rule: null, form: EMPTY_RULE_FORM }); }}
                                className="inline-flex items-center gap-1.5 rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
                            >
                                <Plus className="h-4 w-4" /> Tambah Aturan
                            </button>
                        ) : rules ? (
                            <span className="rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-500">Hanya admin yang dapat mengedit</span>
                        ) : null}
                    </div>

                    {notice ? <p className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-800" role="status">{notice}</p> : null}
                    {loadError ? <p className="mt-6 text-sm text-red-600">{loadError}</p> : null}

                    {rules ? (
                        <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white">
                            {rules.map((rule, idx) => {
                                const tone = SEVERITY_TONE[rule.severity] ?? SEVERITY_TONE.MEDIUM;
                                const open = expanded === rule.id;
                                return (
                                    <div key={rule.id} data-testid={`rule-${rule.rule_number}`} className={idx < rules.length - 1 ? "border-b border-gray-100" : undefined} style={{ opacity: rule.is_active ? 1 : 0.55 }}>
                                        <button
                                            type="button"
                                            onClick={() => setExpanded(open ? null : rule.id)}
                                            aria-expanded={open}
                                            className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left hover:bg-gray-50"
                                        >
                                            <span className="w-[68px] shrink-0 font-mono text-[11px] font-semibold tracking-wide text-gray-400">{rule.rule_number}</span>
                                            <span className="flex-1 truncate text-sm font-medium text-gray-900">{rule.title}</span>
                                            <span className="rounded px-2 py-0.5 text-[11px] font-semibold" style={{ background: tone.bg, color: tone.color }}>{rule.severity}</span>
                                            {!rule.is_active ? <span className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[10.5px] text-gray-500">Nonaktif</span> : null}
                                            <ChevronDown className="h-3.5 w-3.5 text-gray-400 transition-transform" style={{ transform: open ? "rotate(180deg)" : undefined }} />
                                        </button>
                                        {open ? (
                                            <div className="border-t border-gray-100 px-5 pb-4 pl-[92px] pt-3">
                                                <p className="text-sm leading-relaxed text-gray-600">{rule.description}</p>
                                                {Object.keys(rule.thresholds ?? {}).length > 0 ? (
                                                    <div className="mt-3 flex flex-wrap gap-1.5">
                                                        {Object.entries(rule.thresholds).map(([k, v]) => (
                                                            <span key={k} className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-[11px] text-gray-700">{k}: {String(v)}</span>
                                                        ))}
                                                    </div>
                                                ) : null}
                                                {isAdmin ? (
                                                    <div className="mt-3 flex gap-2">
                                                        <button type="button" onClick={() => { setFormError(null); setEditor({ rule, form: toForm(rule) }); }} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                                                            <Pencil className="h-3 w-3" /> Ubah
                                                        </button>
                                                        <button type="button" onClick={() => void toggleActive(rule)} disabled={togglingId === rule.id} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                                                            <Power className="h-3 w-3" /> {rule.is_active ? "Nonaktifkan" : "Aktifkan"}
                                                        </button>
                                                    </div>
                                                ) : null}
                                            </div>
                                        ) : null}
                                    </div>
                                );
                            })}
                            {rules.length === 0 ? <p className="px-5 py-10 text-center text-sm text-gray-500">Belum ada aturan.</p> : null}
                        </div>
                    ) : null}

                    {rules && !isAdmin ? (
                        <div className="mt-4 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-gray-600">
                            <Shield className="h-3.5 w-3.5" />
                            <span>Hanya administrator yang dapat mengubah aturan playbook. Hubungi C-Level Anda untuk meminta perubahan.</span>
                        </div>
                    ) : null}
                </div>
            </div>

            <Modal
                open={editor !== null}
                onClose={() => setEditor(null)}
                size="md"
                breadcrumbs={[editor?.rule ? "Ubah Aturan" : "Tambah Aturan Baru"]}
                footerStatus={formError ? <span className="text-xs text-red-600">{formError}</span> : null}
                primaryAction={{
                    label: editor?.rule ? "Simpan" : "Buat",
                    onClick: () => void save(),
                    disabled: saving || !editor || !editor.form.rule_number.trim() || !editor.form.title.trim() || !editor.form.description.trim(),
                }}
                cancelAction={{ label: "Batalkan", onClick: () => setEditor(null), disabled: saving }}
            >
                {editor ? <RuleForm value={editor.form} onChange={(form) => setEditor({ ...editor, form })} disabled={saving} /> : null}
            </Modal>
        </div>
    );
}

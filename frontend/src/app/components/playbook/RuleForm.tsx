"use client";

import { RULE_SEVERITIES, type RuleSeverity } from "./playbookTypes";

// The rule editor fields, shared by the /playbook modal and the workspace
// drawer. Thresholds are edited as JSON text; the caller parses on save.

export interface RuleFormValue {
    rule_number: string;
    title: string;
    description: string;
    thresholdsText: string;
    severity: RuleSeverity;
    is_active: boolean;
}

export const EMPTY_RULE_FORM: RuleFormValue = {
    rule_number: "",
    title: "",
    description: "",
    thresholdsText: "{}",
    severity: "HIGH",
    is_active: true,
};

const field = "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none disabled:bg-gray-50 disabled:text-gray-500";
const label = "block text-xs font-medium text-gray-600";

export function RuleForm({
    value,
    onChange,
    disabled = false,
    showRuleNumber = true,
    showActive = false,
}: {
    value: RuleFormValue;
    onChange: (next: RuleFormValue) => void;
    disabled?: boolean;
    showRuleNumber?: boolean;
    showActive?: boolean;
}) {
    const set = <K extends keyof RuleFormValue>(key: K, v: RuleFormValue[K]) => onChange({ ...value, [key]: v });
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
                {showRuleNumber ? (
                    <label className="space-y-1.5">
                        <span className={label}>Nomor Aturan</span>
                        <input value={value.rule_number} onChange={(e) => set("rule_number", e.target.value)} disabled={disabled} placeholder="cth. RULE 15" className={field} />
                    </label>
                ) : null}
                <label className="space-y-1.5">
                    <span className={label}>Severity</span>
                    <select value={value.severity} onChange={(e) => set("severity", e.target.value as RuleSeverity)} disabled={disabled} className={field}>
                        {RULE_SEVERITIES.map((s) => (
                            <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>
                        ))}
                    </select>
                </label>
                {showActive ? (
                    <label className="space-y-1.5">
                        <span className={label}>Status</span>
                        <span className="flex h-[38px] items-center gap-2 rounded-lg border border-gray-200 px-3 text-sm">
                            <input type="checkbox" checked={value.is_active} onChange={(e) => set("is_active", e.target.checked)} disabled={disabled} aria-label="Aktif" />
                            {value.is_active ? "Aktif" : "Nonaktif"}
                        </span>
                    </label>
                ) : null}
            </div>
            <label className="block space-y-1.5">
                <span className={label}>Judul</span>
                <input value={value.title} onChange={(e) => set("title", e.target.value)} disabled={disabled} placeholder="Judul aturan" className={field} />
            </label>
            <label className="block space-y-1.5">
                <span className={label}>Deskripsi</span>
                <textarea value={value.description} onChange={(e) => set("description", e.target.value)} disabled={disabled} rows={4} placeholder="Deskripsi aturan secara detail..." className={field} />
            </label>
            <label className="block space-y-1.5">
                <span className={label}>Thresholds (JSON)</span>
                <textarea value={value.thresholdsText} onChange={(e) => set("thresholdsText", e.target.value)} disabled={disabled} rows={3} placeholder='{"min_months": 6}' className={`${field} font-mono text-xs`} />
                <span className="block text-xs text-gray-500">Parameter yang dirender ke prompt AI sebagai <span className="font-mono">Thresholds: {"{...}"}</span>.</span>
            </label>
        </div>
    );
}

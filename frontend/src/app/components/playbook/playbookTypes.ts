// Wire types for the playbook admin (mirror of backend/src/modules/playbook).

export const RULE_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export interface PlaybookRule {
    id: string;
    rule_number: string;
    title: string;
    description: string;
    thresholds: Record<string, unknown>;
    severity: RuleSeverity;
    is_active: boolean;
    created_at: string;
    updated_at: string | null;
}

export interface PlaybookRuleInput {
    rule_number: string;
    title: string;
    description: string;
    thresholds: Record<string, unknown>;
    severity: RuleSeverity;
    is_active?: boolean;
}

export type PlaybookRulePatch = Partial<PlaybookRuleInput>;

export const SEVERITY_TONE: Record<string, { color: string; bg: string }> = {
    CRITICAL: { color: "#DC2626", bg: "#FEF2F2" },
    HIGH: { color: "#C2410C", bg: "#FFF7ED" },
    MEDIUM: { color: "#B45309", bg: "#FFFBEB" },
};

/** Parse the thresholds textarea; null when it is not a JSON object. */
export function parseThresholds(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (!trimmed) return {};
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

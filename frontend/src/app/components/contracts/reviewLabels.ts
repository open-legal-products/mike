// Bahasa Indonesia labels for the review workspace, verbatim from Janus.
// Severity / priority / assessment badge TEXT stays in English by design.

export const PLAYBOOK_LABELS: Record<string, string> = {
    contract_period: "Jangka Waktu Kontrak",
    payment_terms: "Ketentuan Pembayaran",
    liability_scope: "Cakupan Tanggung Jawab",
    claim_process: "Proses Klaim",
    claim_settlement: "Penyelesaian Klaim",
    liability_cap: "Batas Tanggung Jawab",
    indirect_loss: "Kerugian Tidak Langsung",
    termination: "Pengakhiran",
    signatory: "Penandatangan",
    late_payment: "Keterlambatan Pembayaran",
    ownership_after_settlement: "Kepemilikan Setelah Penyelesaian",
    auto_renewal: "Perpanjangan Otomatis",
};

export const PLAYBOOK_STATUS_LABEL: Record<string, string> = {
    compliant: "Sesuai",
    needs_attention: "Perlu Perhatian",
    non_compliant: "Tidak Sesuai",
    not_found: "Tidak Ditemukan",
};

export const PLAYBOOK_STATUS_COLOR: Record<string, string> = {
    compliant: "#059669",
    needs_attention: "#D97706",
    non_compliant: "#DC2626",
    not_found: "#6B7280",
};

export const SEVERITY_COLOR: Record<string, string> = {
    CRITICAL: "#DC2626",
    HIGH: "#EA580C",
    MEDIUM: "#D97706",
    LOW: "#6B7280",
};

export const PRIORITY_LABEL: Record<string, string> = {
    MUST_CHANGE: "MUST CHANGE",
    SHOULD_CHANGE: "SHOULD CHANGE",
    NICE_TO_HAVE: "NICE TO HAVE",
};

export const PRIORITY_COLOR: Record<string, string> = {
    MUST_CHANGE: "#DC2626",
    SHOULD_CHANGE: "#D97706",
    NICE_TO_HAVE: "#6B7280",
};

export const ASSESSMENT_COLOR: Record<string, string> = {
    GOOD: "#059669",
    ACCEPTABLE: "#2563EB",
    NEEDS_APPROVAL: "#D97706",
    CRITICAL: "#DC2626",
};

export const RISK_HEADER_LABEL: Record<string, string> = {
    CRITICAL: "Risiko Kritis",
    HIGH: "Risiko Tinggi",
    MEDIUM: "Risiko Sedang",
    LOW: "Risiko Rendah",
};

export const RECOMMENDATION_PILL: Record<string, string> = {
    READY_TO_SIGN: "SIAP DITANDATANGANI",
    NEEDS_REVISIONS: "PERLU REVISI",
    ESCALATE_TO_CEO_COO: "ESKALASI KE CEO/COO",
    DO_NOT_SIGN: "JANGAN DITANDATANGANI",
};

export const SECTION_TITLES = {
    executive: "Ringkasan Eksekutif",
    playbook: "Kepatuhan Playbook",
    heatmap: "Peta Risiko Klausul",
    redFlags: "Tanda Bahaya & Risiko Kritis",
    revisions: "Saran Revisi",
    clarifications: "Klarifikasi Diperlukan",
    financial: "Analisis Komersial & Keuangan",
    missing: "Klausul yang Hilang",
    yellow: "Peringatan",
    positive: "Temuan Positif",
} as const;

export function formatCreatedAt(iso: string): string {
    return new Date(iso).toLocaleDateString("id-ID", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

// Ported 1:1 from Janus (src/lib/agentActions.ts computeReviewStats/filterReviews
// + the label/color maps in src/pages/Index.tsx) so the dashboard numbers and
// Bahasa strings match Janus exactly. Pure — no React/DOM.

export type ReviewRow = {
  id: string;
  user_id: string | null;
  title: string | null;
  client_name: string | null;
  document_type: string | null;
  risk_level: string | null;
  recommendation: string | null;
  status: string | null;
  created_at: string;
  expiry_date: string | null;
  uploader_email: string | null;
};

export interface ReviewStats {
  thisMonth: ReviewRow[];
  criticalCount: number;
  expiringSoon: ReviewRow[];
}

// Full-day difference (later - earlier), truncated — mirrors date-fns differenceInDays
// for the non-negative expiry window we care about.
export function differenceInDays(later: Date, earlier: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}

/** Reviews created this calendar month, CRITICAL count, and contracts expiring within 0–60 days. */
export function computeReviewStats(reviews: ReviewRow[], now: Date = new Date()): ReviewStats {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thisMonth = reviews.filter((r) => r.created_at >= monthStart);
  const criticalCount = reviews.filter((r) => r.risk_level === "CRITICAL").length;
  const expiringSoon = reviews
    .filter((r) => {
      if (!r.expiry_date) return false;
      const days = differenceInDays(new Date(r.expiry_date), now);
      return days >= 0 && days <= 60;
    })
    .sort((a, b) => new Date(a.expiry_date!).getTime() - new Date(b.expiry_date!).getTime());
  return { thisMonth, criticalCount, expiringSoon };
}

/** Dashboard search + risk + status filters. */
export function filterReviews(
  reviews: ReviewRow[],
  opts: { search: string; risk: string; status: string },
): ReviewRow[] {
  return reviews.filter((r) => {
    if (
      opts.search &&
      !(r.client_name ?? "").toLowerCase().includes(opts.search.toLowerCase()) &&
      !(r.title ?? "").toLowerCase().includes(opts.search.toLowerCase())
    )
      return false;
    if (opts.risk !== "all" && r.risk_level !== opts.risk) return false;
    if (opts.status !== "all" && r.status !== opts.status) return false;
    return true;
  });
}

// ── Label + color maps (verbatim from Janus Index.tsx) ────────────────────────

export const RISK_DOT: Record<string, string> = {
  CRITICAL: "#DC2626",
  HIGH: "#EA580C",
  MEDIUM: "#D97706",
  LOW: "#16A34A",
};

export const RISK_LABEL: Record<string, string> = {
  CRITICAL: "Kritis",
  HIGH: "Tinggi",
  MEDIUM: "Sedang",
  LOW: "Rendah",
};

export const REC_LABEL: Record<string, string> = {
  READY_TO_SIGN: "Siap Ditandatangani",
  NEEDS_REVISIONS: "Perlu Revisi",
  ESCALATE_TO_CEO_COO: "Eskalasi CEO/COO",
  DO_NOT_SIGN: "Jangan Ditandatangani",
};

export const REC_COLOR: Record<string, string> = {
  READY_TO_SIGN: "#16A34A",
  NEEDS_REVISIONS: "#D97706",
  ESCALATE_TO_CEO_COO: "#EA580C",
  DO_NOT_SIGN: "#DC2626",
};

export const STATUS_LABEL: Record<string, string> = {
  processing: "Memproses",
  ai_reviewed: "Ditinjau AI",
  clevel_reviewed: "Ditinjau C-Level",
  signed: "Ditandatangani",
  archived: "Diarsipkan",
};

export const RISK_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "Semua Risiko" },
  { value: "CRITICAL", label: "Kritis" },
  { value: "HIGH", label: "Tinggi" },
  { value: "MEDIUM", label: "Sedang" },
  { value: "LOW", label: "Rendah" },
];

export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "Semua Status" },
  { value: "processing", label: "Memproses" },
  { value: "ai_reviewed", label: "Ditinjau AI" },
  { value: "clevel_reviewed", label: "Ditinjau C-Level" },
  { value: "signed", label: "Ditandatangani" },
  { value: "archived", label: "Diarsipkan" },
];

// ── New-review constants (verbatim from Janus src/types/review.ts) ────────────

export const DOCUMENT_TYPES: { value: string; label: string }[] = [
  { value: "PKS", label: "Kontrak Lengkap (PKS)" },
  { value: "LOI", label: "Letter of Intent (LOI)" },
  { value: "NDA", label: "Perjanjian Kerahasiaan (NDA)" },
  { value: "Client Template", label: "Template Klien" },
  { value: "Other", label: "Lainnya" },
];

export const REVIEW_FOCUS_OPTIONS: string[] = [
  "Menyeluruh",
  "Ketentuan Keuangan",
  "Tanggung Jawab & Risiko",
  "Cakupan Layanan",
  "Ketentuan Pembayaran",
  "Pengakhiran Kontrak",
  "Kelayakan Operasional",
  "Kepatuhan Hukum",
];

export const PROCESSING_STEPS: string[] = [
  "Mengekstrak teks dokumen...",
  "Menganalisis struktur kontrak...",
  "Memeriksa terhadap Playbook Dash...",
  "Mengevaluasi tanggung jawab & risiko...",
  "Meninjau ketentuan keuangan...",
  "Mencocokkan dengan konteks proyek...",
  "Mencocokkan pustaka klausul...",
  "Menyusun rekomendasi...",
];

/** Weighted-average risk enum → bucketed enum, 'N/A' if none scored (from Janus computeAvgRisk). */
export function computeAvgRisk(reviews: { risk_level: string | null }[]): string {
  const scored = reviews.filter((r) => r.risk_level);
  if (scored.length === 0) return "N/A";
  const map: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  const avg = scored.reduce((s, r) => s + (map[r.risk_level!] ?? 0), 0) / scored.length;
  if (avg <= 1.5) return "LOW";
  if (avg <= 2.5) return "MEDIUM";
  if (avg <= 3.5) return "HIGH";
  return "CRITICAL";
}

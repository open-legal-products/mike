// The two Gemini prompts behind a contract review, ported verbatim from the
// Janus edge functions `review-contract` and `generate-negotiation-memo`
// (supabase/functions/*). Mike now calls the model directly through OpenRouter
// instead of proxying through janus-tools → Lovable, so the playbook rules,
// clause-library context and feedback context are all assembled here.
//
// Model ids are OpenRouter slugs; the same models Janus used on the Lovable
// gateway, so review output stays comparable. Override with CONTRACTS_AI_MODEL.

import { AiGatewayError, firstMessage, openRouterChat, type ChatFn, type ChatTool } from "../../lib/openRouterChat";
import type { NegotiationMemo, ReviewOutput } from "./contracts.types";
import type { PromptRule } from "../playbook/playbook.service";

export const PRIMARY_MODEL = process.env.CONTRACTS_AI_MODEL?.trim() || "google/gemini-2.5-pro";
export const FALLBACK_MODEL = process.env.CONTRACTS_AI_FALLBACK_MODEL?.trim() || "google/gemini-2.5-flash";

// ── Contract review ────────────────────────────────────────────────────────

export function buildReviewSystemPrompt(rules: PromptRule[]): string {
  const rulesBlock = rules
    .map((r) => {
      const thresholdInfo = Object.keys(r.thresholds || {}).length > 0 ? ` Thresholds: ${JSON.stringify(r.thresholds)}.` : "";
      return `${r.rule_number} (${r.severity}) — ${r.title}: ${r.description}${thresholdInfo}`;
    })
    .join("\n");

  return `BAHASA: Seluruh output kamu HARUS dalam Bahasa Indonesia. Semua nilai string dalam tool arguments harus ditulis dalam Bahasa Indonesia — termasuk executive_summary, issue, business_impact, rationale, recommendations, assessments, dan semua teks lainnya.

Pengecualian — tetap dalam Bahasa Inggris:
- Field/key nama (executive_summary, red_flags, dst.)
- Severity labels (CRITICAL, HIGH, MEDIUM, LOW)
- Priority labels (MUST_CHANGE, SHOULD_CHANGE, NICE_TO_HAVE)
- Assessment labels (GOOD, ACCEPTABLE, NEEDS_APPROVAL)
- Recommendation labels (READY_TO_SIGN, NEEDS_REVISIONS, ESCALATE_TO_CEO_COO, DO_NOT_SIGN)
- Status labels (compliant, needs_attention, non_compliant, not_found)
- Playbook rule references (RULE 1, RULE 6, GP5, dst.)
- ID prefixes (RF-001, REV-001, CLR-001)
- Assign_to values (BD Team, SD Operations, Finance, Client, CEO-COO)

Untuk kutipan klausul kontrak (original_text, highlight_text, clause_text), gunakan bahasa asli yang tertulis di kontrak.

Untuk setiap item dalam red_flags, revisions, clarifications, yellow_flags, dan positive_findings, WAJIB sertakan field 'highlight_text': kutipan PERSIS dari teks kontrak (10-100 kata) yang bisa di-match secara programatis.

You are a senior legal and contract reviewer (ex-Chief Legal Officer, 20 years B2B commercial law in Indonesia, in-house counsel for a logistics company). Review contracts from our company's perspective as the LOGISTICS SERVICE PROVIDER. Protect our interests while keeping fairness.

OUR CONTRACT REVIEW PLAYBOOK (MANDATORY RULES)
Evaluate EVERY contract against these rules. Any violation MUST be flagged.

${rulesBlock}

ADDITIONAL CHECKS
CHECK A — Bilingual consistency (EN/ID translation mismatches, governing language)
CHECK B — Signatory completeness (names, addresses, titles, blanks, placeholders)
CHECK C — Operational specifics (temperature, vehicle type, loading/unloading, staff, return logistics, parking, tolls, detention, working hours, surcharges)
CHECK D — Indonesian regulatory (KUH Perdata, BANI arbitration, materai, PPN/PPh)
CHECK E — Insurance (recommend if goods > IDR 500k/package)

CLAUSE LIBRARY CONTEXT — Jika tersedia, prefer wording dari pustaka klausul. Set from_clause_library=true dan cite clause_library_source.

PAST FEEDBACK CONTEXT — Pertimbangkan koreksi C-Level sebelumnya.

SECTION RISK SCORING — score every major clause 1-10. Labels: 1-3=RENDAH, 4-6=SEDANG, 7-8=TINGGI, 9-10=KRITIS.

PLAYBOOK COMPLIANCE — Untuk setiap rule (contract_period, payment_terms, liability_scope, claim_process, claim_settlement, liability_cap, indirect_loss, termination, signatory, late_payment, ownership_after_settlement, auto_renewal): WAJIB sertakan status, assessment, clause_reference, clause_text, dan playbook_threshold. Jika tidak ditemukan, isi clause_reference="Tidak ditemukan" dan clause_text="Tidak ada klausul terkait".

CRITICAL: Kembalikan hasil HANYA dengan memanggil function "submit_contract_review". JANGAN tulis JSON sebagai teks. JANGAN tulis penjelasan di luar tool call.`;
}

export interface ReviewPromptInput {
  contract_text: string;
  client_name: string;
  document_type: string;
  project_context?: string | null;
  review_focus?: string[] | null;
  clause_library_context?: string | null;
  past_feedback_context?: string | null;
}

export function buildReviewUserMessage(input: ReviewPromptInput): string {
  return `DOCUMENT TYPE
${input.document_type}

CLIENT
${input.client_name}

CONTRACT TEXT
${input.contract_text}

PROJECT CONTEXT
${input.project_context || "No additional context provided."}

REVIEW FOCUS
${Array.isArray(input.review_focus) && input.review_focus.length > 0 ? input.review_focus.join(", ") : "Comprehensive"}

OUR COMPANY CLAUSE LIBRARY (Approved Wordings)
${input.clause_library_context || "No clause library entries available yet."}

PAST REVIEW PATTERNS
${input.past_feedback_context || "No past reviews for this client."}`;
}

/** Tool/function schema mirroring ReviewOutput (contracts.types.ts). */
export const REVIEW_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "submit_contract_review",
    description: "Submit the structured contract review output.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        executive_summary: { type: "string" },
        client_name: { type: "string" },
        contract_type: { type: "string" },
        template_used: { type: "string" },
        overall_recommendation: { type: "string", enum: ["READY_TO_SIGN", "NEEDS_REVISIONS", "ESCALATE_TO_CEO_COO", "DO_NOT_SIGN"] },
        risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
        red_flags: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM"] },
              clause: { type: "string" },
              title: { type: "string" },
              issue: { type: "string" },
              business_impact: { type: "string" },
              action: { type: "string" },
              playbook_rule: { type: "string" },
              requires_approval: { type: ["string", "null"] },
              highlight_text: { type: "string" },
            },
            required: ["id", "severity", "clause", "title", "issue", "business_impact", "action", "playbook_rule", "highlight_text"],
          },
        },
        revisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              clause: { type: "string" },
              original_text: { type: "string" },
              suggested_text: { type: "string" },
              rationale: { type: "string" },
              priority: { type: "string", enum: ["MUST_CHANGE", "SHOULD_CHANGE", "NICE_TO_HAVE"] },
              from_clause_library: { type: "boolean" },
              clause_library_source: { type: ["string", "null"] },
              highlight_text: { type: "string" },
            },
            required: ["id", "clause", "original_text", "suggested_text", "rationale", "priority", "from_clause_library", "highlight_text"],
          },
        },
        clarifications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              question: { type: "string" },
              clause: { type: "string" },
              assign_to: { type: "string" },
              highlight_text: { type: "string" },
            },
            required: ["id", "question", "clause", "assign_to", "highlight_text"],
          },
        },
        financial_review: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string" },
              finding: { type: "string" },
              assessment: { type: "string", enum: ["GOOD", "ACCEPTABLE", "NEEDS_APPROVAL", "CRITICAL"] },
              recommendation: { type: "string" },
            },
            required: ["item", "finding", "assessment", "recommendation"],
          },
        },
        missing_clauses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              clause_name: { type: "string" },
              description: { type: "string" },
              suggested_wording: { type: "string" },
              importance: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
              from_clause_library: { type: "boolean" },
              clause_library_source: { type: ["string", "null"] },
            },
            required: ["clause_name", "description", "suggested_wording", "importance", "from_clause_library"],
          },
        },
        yellow_flags: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string" },
              clause: { type: ["string", "null"] },
              note: { type: "string" },
              highlight_text: { type: ["string", "null"] },
            },
            required: ["item", "note"],
          },
        },
        positive_findings: {
          type: "array",
          items: {
            type: "object",
            properties: { clause: { type: "string" }, finding: { type: "string" }, highlight_text: { type: "string" } },
            required: ["clause", "finding", "highlight_text"],
          },
        },
        section_risks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              clause_reference: { type: "string" },
              clause_title: { type: "string" },
              risk_score: { type: "number" },
              risk_label: { type: "string", enum: ["RENDAH", "SEDANG", "TINGGI", "KRITIS"] },
              primary_issues: { type: "array", items: { type: "string" } },
            },
            required: ["clause_reference", "clause_title", "risk_score", "risk_label", "primary_issues"],
          },
        },
        playbook_compliance: {
          type: "object",
          description:
            "Object keyed by rule slug (contract_period, payment_terms, liability_scope, claim_process, claim_settlement, liability_cap, indirect_loss, termination, signatory, late_payment, ownership_after_settlement, auto_renewal). Each value has status/assessment/clause_reference/clause_text/playbook_threshold.",
          additionalProperties: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["compliant", "needs_attention", "non_compliant", "not_found"] },
              assessment: { type: "string" },
              clause_reference: { type: "string" },
              clause_text: { type: "string" },
              playbook_threshold: { type: "string" },
            },
            required: ["status", "assessment"],
          },
        },
      },
      required: [
        "executive_summary",
        "client_name",
        "contract_type",
        "template_used",
        "overall_recommendation",
        "risk_level",
        "red_flags",
        "revisions",
        "clarifications",
        "financial_review",
        "missing_clauses",
        "yellow_flags",
        "positive_findings",
        "section_risks",
        "playbook_compliance",
      ],
    },
  },
};

const ARRAY_FIELDS = ["red_flags", "revisions", "clarifications", "financial_review", "missing_clauses", "yellow_flags", "positive_findings", "section_risks"] as const;
const RECOMMENDATIONS = ["READY_TO_SIGN", "NEEDS_REVISIONS", "ESCALATE_TO_CEO_COO", "DO_NOT_SIGN"];
const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const RISK_LABELS = ["RENDAH", "SEDANG", "TINGGI", "KRITIS"];

/** Same defensive normalisation Janus applied before persisting. */
export function normalizeReviewOutput(raw: unknown): ReviewOutput {
  const out: Record<string, unknown> = { ...((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>) };
  for (const f of ARRAY_FIELDS) if (!Array.isArray(out[f])) out[f] = [];
  if (!out.playbook_compliance || typeof out.playbook_compliance !== "object" || Array.isArray(out.playbook_compliance)) out.playbook_compliance = {};
  out.executive_summary = out.executive_summary || "";
  out.client_name = out.client_name || "";
  out.contract_type = out.contract_type || "";
  out.template_used = out.template_used || "Unknown";
  if (!RECOMMENDATIONS.includes(out.overall_recommendation as string)) out.overall_recommendation = "NEEDS_REVISIONS";
  if (!RISK_LEVELS.includes(out.risk_level as string)) out.risk_level = "MEDIUM";
  out.section_risks = (out.section_risks as Array<Record<string, unknown>>).map((s) => {
    const score = Math.max(1, Math.min(10, Math.round(Number(s?.risk_score) || 1)));
    let label = s?.risk_label as string;
    if (!RISK_LABELS.includes(label)) label = score <= 3 ? "RENDAH" : score <= 6 ? "SEDANG" : score <= 8 ? "TINGGI" : "KRITIS";
    return {
      clause_reference: (s?.clause_reference as string) || "",
      clause_title: (s?.clause_title as string) || "",
      risk_score: score,
      risk_label: label,
      primary_issues: Array.isArray(s?.primary_issues) ? s.primary_issues : [],
    };
  });
  return out as unknown as ReviewOutput;
}

function parseToolArguments(json: unknown): unknown | null {
  const message = firstMessage(json);
  const args = message?.tool_calls?.[0]?.function?.arguments;
  if (args === undefined || args === null) {
    console.warn("[contracts.ai] no tool_call in response; message keys:", Object.keys(message ?? {}));
    return null;
  }
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch (e) {
    console.error("[contracts.ai] tool args JSON.parse failed:", e, "snippet:", args.slice(0, 500));
    return null;
  }
}

function gatewayFailure(status: number, errorText: string | null, stage: string): AiGatewayError {
  if (status === 429) return new AiGatewayError(429, "Rate limited. Please try again in a moment.");
  if (status === 402) return new AiGatewayError(402, "AI usage limit reached. Please add credits.");
  console.error(`[contracts.ai] gateway error (${stage}):`, status, errorText?.slice(0, 500));
  return new AiGatewayError(status, `AI gateway error: ${status}`);
}

/**
 * Run the review prompt: primary model with a forced tool call; on gateway
 * failure fall back to the flash model; if no parseable tool call comes back,
 * retry once with flash. Mirrors review-contract's control flow.
 */
export async function runContractReviewAi(
  args: { rules: PromptRule[]; input: ReviewPromptInput },
  chat: ChatFn = openRouterChat,
): Promise<ReviewOutput> {
  const systemPrompt = buildReviewSystemPrompt(args.rules);
  const userMessage = buildReviewUserMessage(args.input);
  const request = (model: string) => ({
    model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userMessage },
    ],
    tools: [REVIEW_TOOL],
    tool_choice: { type: "function" as const, function: { name: "submit_contract_review" } },
    temperature: 0.1,
  });

  let response = await chat(request(PRIMARY_MODEL));
  if (!response.ok) {
    if (response.status === 429 || response.status === 402) throw gatewayFailure(response.status, response.errorText, "primary");
    console.error("[contracts.ai] gateway error (primary):", response.status, response.errorText?.slice(0, 500));
    response = await chat(request(FALLBACK_MODEL));
    if (!response.ok) throw gatewayFailure(response.status, response.errorText, "fallback");
  }

  let parsed = parseToolArguments(response.json);
  if (!parsed) {
    console.log("[contracts.ai] retrying with fallback model (forced tool call)");
    const retry = await chat(request(FALLBACK_MODEL));
    if (retry.ok) parsed = parseToolArguments(retry.json);
  }
  if (!parsed) throw new AiGatewayError(422, "AI tidak mengembalikan struktur yang valid. Silakan coba lagi.");
  return normalizeReviewOutput(parsed);
}

// ── Negotiation memo ───────────────────────────────────────────────────────

export function buildMemoSystemPrompt(): string {
  return `Kamu adalah konsultan negosiasi kontrak senior untuk PT Dash Elektrik Indonesia, sebuah perusahaan logistik B2B yang beroperasi di Jabodetabek. Kamu membantu tim Business Development (BD) menyiapkan strategi negosiasi dengan klien berdasarkan hasil tinjauan kontrak dari C-Level (COO).

ATURAN:
1. Semua output HARUS dalam Bahasa Indonesia kecuali JSON field names, ID prefixes, dan severity/priority labels.
2. Gunakan bahasa yang profesional, diplomatis, dan berorientasi bisnis — bukan bahasa hukum teknis.
3. Setiap poin negosiasi harus memiliki "talking_script" yang bisa langsung dibaca oleh tim BD saat meeting dengan klien.
4. Bedakan antara poin yang WAJIB diubah (deal breaker) vs yang bisa dikompromikan.
5. Pertimbangkan hubungan bisnis jangka panjang — jangan terlalu agresif pada poin yang tidak kritis.
6. Jika ada temuan yang di-dismiss oleh COO, JANGAN masukkan ke dalam memo negosiasi.

OUTPUT FORMAT
Respond ONLY in valid JSON (no markdown, no backticks, no preamble):
{
  "memo_title": "string — judul memo, e.g. 'Memo Negosiasi: PT XYZ — PKS Logistik'",
  "overall_tone_recommendation": "cooperative | firm | cautious",
  "tone_explanation": "string — penjelasan mengapa tone ini direkomendasikan",
  "opening_statement": "string — kalimat pembuka yang bisa digunakan tim BD saat memulai diskusi negosiasi",
  "must_change": [
    {
      "id": "NEG-MC-001",
      "title": "string — judul singkat poin negosiasi",
      "clause_reference": "string — referensi pasal",
      "what_to_ask": "string — apa yang harus diminta ke klien",
      "business_impact": "string — mengapa ini penting bagi Dash",
      "ideal_position": "string — posisi ideal Dash",
      "fallback_position": "string — posisi fallback jika klien menolak",
      "talking_script": "string — skrip bicara untuk tim BD, siap pakai",
      "source_finding_ids": ["REV-001", "RF-002"]
    }
  ],
  "should_change": [
    {
      "id": "NEG-SC-001",
      "title": "string",
      "clause_reference": "string",
      "what_to_ask": "string",
      "business_impact": "string",
      "ideal_position": "string",
      "fallback_position": "string",
      "talking_script": "string",
      "source_finding_ids": ["REV-003"]
    }
  ],
  "nice_to_discuss": [
    {
      "id": "NEG-ND-001",
      "title": "string",
      "clause_reference": "string",
      "what_to_ask": "string",
      "business_impact": "string",
      "ideal_position": "string",
      "fallback_position": "string",
      "talking_script": "string",
      "source_finding_ids": ["CLR-001"]
    }
  ],
  "do_not_raise": [
    {
      "id": "NEG-DNR-001",
      "title": "string — poin yang sebaiknya tidak diangkat",
      "reason": "string — alasan mengapa tidak perlu dibahas"
    }
  ],
  "closing_guidance": "string — panduan penutup negosiasi untuk tim BD",
  "red_lines": [
    {
      "description": "string — batas yang tidak boleh dilanggar",
      "reason": "string — alasan mengapa ini garis merah"
    }
  ]
}`;
}

export interface MemoFeedbackRow {
  finding_type: string;
  finding_id: string;
  action: string;
  rationale?: string | null;
  edited_text?: string | null;
}
export interface PastMemo {
  title: string;
  negotiation_memo: unknown;
}

/** One line per finding with the COO's decision — the review_feedback key scheme. */
export function buildCooDecisions(aiOutput: ReviewOutput, feedback: MemoFeedbackRow[]): string[] {
  const map = new Map<string, MemoFeedbackRow>();
  for (const fb of feedback || []) map.set(`${fb.finding_type}:${fb.finding_id}`, fb);
  const lines: string[] = [];
  for (const rf of aiOutput.red_flags ?? []) {
    const fb = map.get(`red_flag:${rf.id}`);
    lines.push(`[${rf.id}] ${rf.title} (${rf.severity}) — COO: ${fb ? fb.action : "tidak ditinjau"}${fb?.rationale ? ` — Alasan: ${fb.rationale}` : ""}`);
  }
  for (const rev of aiOutput.revisions ?? []) {
    const fb = map.get(`revision:${rev.id}`);
    const edited = fb?.edited_text ? ` — Teks diedit: "${fb.edited_text}"` : "";
    lines.push(`[${rev.id}] ${rev.clause} (${rev.priority}) — COO: ${fb ? fb.action : "tidak ditinjau"}${edited}${fb?.rationale ? ` — Alasan: ${fb.rationale}` : ""}`);
  }
  for (const clr of aiOutput.clarifications ?? []) {
    const fb = map.get(`clarification:${clr.id}`);
    // Janus stores the clarification answer in `rationale`; older rows used edited_text.
    const answer = fb?.rationale || fb?.edited_text;
    lines.push(`[${clr.id}] ${clr.question} — COO: ${fb ? fb.action : "tidak ditinjau"}${answer ? ` — Jawaban: "${answer}"` : ""}`);
  }
  (aiOutput.missing_clauses ?? []).forEach((mc, i) => {
    const fb = map.get(`missing_clause:MC-${i}`);
    lines.push(`[MC-${i}] ${mc.clause_name} (${mc.importance}) — COO: ${fb ? fb.action : "tidak ditinjau"}${fb?.rationale ? ` — Alasan: ${fb.rationale}` : ""}`);
  });
  (aiOutput.financial_review ?? []).forEach((fin, i) => {
    const fb = map.get(`financial:FIN-${i}`);
    lines.push(`[FIN-${i}] ${fin.item} (${fin.assessment}) — COO: ${fb ? fb.action : "tidak ditinjau"}`);
  });
  return lines;
}

export interface MemoPromptInput {
  title: string;
  client_name: string;
  document_type: string;
  ai_output: ReviewOutput;
  feedback: MemoFeedbackRow[];
  past_memos: PastMemo[];
}

export function buildMemoUserMessage(input: MemoPromptInput): string {
  const cooDecisions = buildCooDecisions(input.ai_output, input.feedback);
  let pastContext = "Tidak ada data negosiasi sebelumnya untuk klien ini.";
  const past = (input.past_memos || []).filter((p) => p && p.negotiation_memo);
  if (past.length > 0) {
    const summaries = past.slice(0, 3).map((p) => {
      const memo = p.negotiation_memo as Record<string, unknown>;
      return `- ${p.title}: Tone "${memo?.overall_tone_recommendation}", ${(memo?.must_change as unknown[])?.length || 0} poin wajib`;
    });
    pastContext = `Data negosiasi sebelumnya untuk ${input.client_name}:\n${summaries.join("\n")}`;
  }
  return `KONTRAK: ${input.title}
KLIEN: ${input.client_name}
TIPE DOKUMEN: ${input.document_type}

RINGKASAN AI:
${input.ai_output.executive_summary}

REKOMENDASI AI: ${input.ai_output.overall_recommendation}
LEVEL RISIKO: ${input.ai_output.risk_level}

KEPUTUSAN COO (C-Level Review):
${cooDecisions.join("\n")}

${pastContext}

Berdasarkan temuan AI dan keputusan COO di atas, buatkan memo negosiasi lengkap untuk tim BD.
- Temuan yang di-dismiss/diabaikan oleh COO JANGAN dimasukkan sebagai poin negosiasi.
- Temuan yang di-valid/diterima oleh COO HARUS dimasukkan sesuai prioritasnya.
- Temuan yang disesuaikan (adjust/edit) oleh COO, gunakan versi COO, bukan versi AI.`;
}

function stripFences(text: string): string {
  return text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
}

/** Memo prompt on the primary model; one JSON-repair retry via the fallback model. */
export async function generateMemoAi(input: MemoPromptInput, chat: ChatFn = openRouterChat): Promise<NegotiationMemo> {
  const response = await chat({
    model: PRIMARY_MODEL,
    messages: [
      { role: "system", content: buildMemoSystemPrompt() },
      { role: "user", content: buildMemoUserMessage(input) },
    ],
    temperature: 0.2,
    max_tokens: 8000,
  });
  if (!response.ok) throw gatewayFailure(response.status, response.errorText, "memo");
  const content = firstMessage(response.json)?.content;
  if (!content) throw new AiGatewayError(502, "No content in AI response");

  try {
    return JSON.parse(stripFences(content)) as NegotiationMemo;
  } catch {
    console.error("[contracts.ai] memo JSON parse failed, repairing with fallback model");
    const repair = await chat({
      model: FALLBACK_MODEL,
      messages: [
        { role: "system", content: "Fix the following text to be valid JSON. Return ONLY valid JSON, no markdown, no explanation." },
        { role: "user", content },
      ],
      temperature: 0,
      max_tokens: 8000,
    });
    if (!repair.ok) throw gatewayFailure(repair.status, repair.errorText, "memo-repair");
    const repaired = firstMessage(repair.json)?.content;
    if (!repaired) throw new AiGatewayError(502, "JSON repair returned no content");
    return JSON.parse(stripFences(repaired)) as NegotiationMemo;
  }
}

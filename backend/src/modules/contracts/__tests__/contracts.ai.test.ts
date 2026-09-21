import { describe, expect, it, vi } from "vitest";
import type { ChatFn, ChatRequest, ChatResponse } from "../../../lib/openRouterChat";
import {
  FALLBACK_MODEL,
  PRIMARY_MODEL,
  buildCooDecisions,
  buildMemoUserMessage,
  buildReviewSystemPrompt,
  buildReviewUserMessage,
  generateMemoAi,
  normalizeReviewOutput,
  runContractReviewAi,
} from "../contracts.ai";
import type { ReviewOutput } from "../contracts.types";

const RULES = [
  { rule_number: "RULE 1", title: "Liability cap", description: "≤ 10x biaya.", thresholds: { max_multiple: 10 }, severity: "CRITICAL" as const },
  { rule_number: "GP1", title: "Prefer own template", description: "Flag client templates.", thresholds: {}, severity: "HIGH" as const },
];

const OUTPUT = {
  executive_summary: "Ringkasan",
  client_name: "A",
  contract_type: "PKS",
  template_used: "Client Template",
  overall_recommendation: "NEEDS_REVISIONS",
  risk_level: "HIGH",
  red_flags: [{ id: "RF-001", severity: "HIGH", clause: "Pasal 2", title: "Termin", issue: "Net 60", business_impact: "Kas", action: "Ubah", playbook_rule: "RULE 2", requires_approval: null }],
  revisions: [{ id: "REV-001", clause: "Pasal 3", original_text: "a", suggested_text: "b", rationale: "r", priority: "MUST_CHANGE", from_clause_library: false, clause_library_source: null }],
  clarifications: [{ id: "CLR-001", question: "Siapa PIC?", clause: "Pasal 4", assign_to: "BD Team" }],
  financial_review: [{ item: "Tarif", finding: "ok", assessment: "GOOD", recommendation: "-" }],
  missing_clauses: [{ clause_name: "Force Majeure", description: "d", suggested_wording: "w", importance: "HIGH", from_clause_library: false, clause_library_source: null }],
  yellow_flags: [],
  positive_findings: [],
  section_risks: [{ clause_reference: "Pasal 3", clause_title: "Liability", risk_score: 14, risk_label: "bogus", primary_issues: ["cap"] }],
  playbook_compliance: {},
} as unknown as ReviewOutput;

function toolResponse(args: unknown): ChatResponse {
  return { ok: true, status: 200, json: { choices: [{ message: { tool_calls: [{ function: { name: "submit_contract_review", arguments: typeof args === "string" ? args : JSON.stringify(args) } }] } }] }, errorText: null };
}
function textResponse(content: string): ChatResponse {
  return { ok: true, status: 200, json: { choices: [{ message: { content } }] }, errorText: null };
}
function errorResponse(status: number): ChatResponse {
  return { ok: false, status, json: null, errorText: `err ${status}` };
}

describe("review prompt", () => {
  it("renders one line per playbook rule with thresholds, and the forced tool call instruction", () => {
    const prompt = buildReviewSystemPrompt(RULES);
    expect(prompt).toContain('RULE 1 (CRITICAL) — Liability cap: ≤ 10x biaya. Thresholds: {"max_multiple":10}.');
    expect(prompt).toContain("GP1 (HIGH) — Prefer own template: Flag client templates.");
    expect(prompt).toContain('memanggil function "submit_contract_review"');
  });

  it("fills the user message with defaults for absent context", () => {
    const msg = buildReviewUserMessage({ contract_text: "PKS...", client_name: "A", document_type: "PKS" });
    expect(msg).toContain("CLIENT\nA");
    expect(msg).toContain("No additional context provided.");
    expect(msg).toContain("REVIEW FOCUS\nComprehensive");
    expect(msg).toContain("No clause library entries available yet.");
    expect(buildReviewUserMessage({ contract_text: "x", client_name: "A", document_type: "PKS", review_focus: ["liability", "payment"], clause_library_context: "CL" })).toContain("REVIEW FOCUS\nliability, payment");
  });

  it("normalises arrays, enums and section risk scores like Janus", () => {
    const out = normalizeReviewOutput({ executive_summary: "x", overall_recommendation: "MAYBE", risk_level: "??", section_risks: [{ risk_score: 14 }, { risk_score: 2, risk_label: "RENDAH" }], playbook_compliance: [] });
    expect(out.red_flags).toEqual([]);
    expect(out.playbook_compliance).toEqual({});
    expect(out.template_used).toBe("Unknown");
    expect(out.overall_recommendation).toBe("NEEDS_REVISIONS");
    expect(out.risk_level).toBe("MEDIUM");
    expect(out.section_risks).toEqual([
      { clause_reference: "", clause_title: "", risk_score: 10, risk_label: "KRITIS", primary_issues: [] },
      { clause_reference: "", clause_title: "", risk_score: 2, risk_label: "RENDAH", primary_issues: [] },
    ]);
  });
});

describe("runContractReviewAi", () => {
  it("forces the tool call on the primary model and returns the normalised output", async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValue(toolResponse(OUTPUT));
    const out = await runContractReviewAi({ rules: RULES, input: { contract_text: "PKS...", client_name: "A", document_type: "PKS" } }, chat);
    expect(out.section_risks[0]).toMatchObject({ risk_score: 10, risk_label: "KRITIS" });
    const req = chat.mock.calls[0][0] as ChatRequest;
    expect(req.model).toBe(PRIMARY_MODEL);
    expect(req.tool_choice).toEqual({ type: "function", function: { name: "submit_contract_review" } });
    expect(req.messages[0].content).toContain("RULE 1 (CRITICAL)");
    expect(req.temperature).toBe(0.1);
  });

  it("falls back to the flash model on a gateway error and surfaces 429/402 immediately", async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValueOnce(errorResponse(500)).mockResolvedValueOnce(toolResponse(OUTPUT));
    const out = await runContractReviewAi({ rules: RULES, input: { contract_text: "x", client_name: "A", document_type: "PKS" } }, chat);
    expect(out.executive_summary).toBe("Ringkasan");
    expect((chat.mock.calls[1][0] as ChatRequest).model).toBe(FALLBACK_MODEL);

    const limited = vi.fn<ChatFn>().mockResolvedValue(errorResponse(429));
    await expect(runContractReviewAi({ rules: RULES, input: { contract_text: "x", client_name: "A", document_type: "PKS" } }, limited)).rejects.toMatchObject({ status: 429 });
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it("retries once with flash when no parseable tool call comes back, then fails with 422", async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValueOnce(textResponse("prose instead of tool call")).mockResolvedValueOnce(toolResponse("{not json"));
    await expect(runContractReviewAi({ rules: RULES, input: { contract_text: "x", client_name: "A", document_type: "PKS" } }, chat)).rejects.toMatchObject({ status: 422 });
    expect(chat).toHaveBeenCalledTimes(2);
    expect((chat.mock.calls[1][0] as ChatRequest).model).toBe(FALLBACK_MODEL);
  });
});

describe("memo prompt", () => {
  it("lists every finding with the COO decision, answers and edits", () => {
    const lines = buildCooDecisions(OUTPUT, [
      { finding_type: "red_flag", finding_id: "RF-001", action: "dismiss", rationale: "Sudah dibahas" },
      { finding_type: "revision", finding_id: "REV-001", action: "edit", edited_text: "Net 30" },
      { finding_type: "clarification", finding_id: "CLR-001", action: "answered", rationale: "Budi" },
    ]);
    expect(lines).toEqual([
      "[RF-001] Termin (HIGH) — COO: dismiss — Alasan: Sudah dibahas",
      '[REV-001] Pasal 3 (MUST_CHANGE) — COO: edit — Teks diedit: "Net 30"',
      '[CLR-001] Siapa PIC? — COO: answered — Jawaban: "Budi"',
      "[MC-0] Force Majeure (HIGH) — COO: tidak ditinjau",
      "[FIN-0] Tarif (GOOD) — COO: tidak ditinjau",
    ]);
  });

  it("summarises up to three past memos for tone continuity", () => {
    const msg = buildMemoUserMessage({
      title: "PKS — A",
      client_name: "A",
      document_type: "PKS",
      ai_output: OUTPUT,
      feedback: [],
      past_memos: [
        { title: "Old 1", negotiation_memo: { overall_tone_recommendation: "firm", must_change: [1, 2] } },
        { title: "Old 2", negotiation_memo: null },
      ],
    });
    expect(msg).toContain('Data negosiasi sebelumnya untuk A:\n- Old 1: Tone "firm", 2 poin wajib');
    expect(msg).not.toContain("Old 2");
    expect(buildMemoUserMessage({ title: "t", client_name: "A", document_type: "PKS", ai_output: OUTPUT, feedback: [], past_memos: [] })).toContain("Tidak ada data negosiasi sebelumnya");
  });
});

describe("generateMemoAi", () => {
  const input = { title: "PKS — A", client_name: "A", document_type: "PKS", ai_output: OUTPUT, feedback: [], past_memos: [] };
  const MEMO = { memo_title: "Memo Negosiasi: A — PKS", must_change: [], should_change: [] };

  it("strips code fences and parses the memo", async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValue(textResponse("```json\n" + JSON.stringify(MEMO) + "\n```"));
    expect(await generateMemoAi(input, chat)).toEqual(MEMO);
    const req = chat.mock.calls[0][0] as ChatRequest;
    expect(req.model).toBe(PRIMARY_MODEL);
    expect(req.temperature).toBe(0.2);
    expect(req.messages[1].content).toContain("KEPUTUSAN COO");
  });

  it("repairs invalid JSON through the fallback model once", async () => {
    const chat = vi.fn<ChatFn>().mockResolvedValueOnce(textResponse("{ memo_title: broken")).mockResolvedValueOnce(textResponse(JSON.stringify(MEMO)));
    expect(await generateMemoAi(input, chat)).toEqual(MEMO);
    const repair = chat.mock.calls[1][0] as ChatRequest;
    expect(repair.model).toBe(FALLBACK_MODEL);
    expect(repair.messages[1].content).toBe("{ memo_title: broken");
  });

  it("maps gateway errors", async () => {
    await expect(generateMemoAi(input, vi.fn<ChatFn>().mockResolvedValue(errorResponse(402)))).rejects.toMatchObject({ status: 402 });
    await expect(generateMemoAi(input, vi.fn<ChatFn>().mockResolvedValue(textResponse("")))).rejects.toMatchObject({ status: 502 });
  });
});

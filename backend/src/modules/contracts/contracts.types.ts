// Wire types for the contract-review domain, ported verbatim from Janus
// (src/types/review.ts, src/types/negotiation.ts). The AI output is produced by
// the janus-tools `run_contract_review` proxy; these shapes are the contract
// the workspace UI, the feedback loop and the negotiation memo rely on.
// Synthetic ids used where the model emits none: FIN-{i}, MC-{i}, YF-{i}, PF-{i}.

export interface RedFlag {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  clause: string;
  title: string;
  issue: string;
  business_impact: string;
  action: string;
  playbook_rule: string;
  requires_approval: string | null;
  highlight_text?: string;
}

export interface Revision {
  id: string;
  clause: string;
  original_text: string;
  suggested_text: string;
  rationale: string;
  priority: "MUST_CHANGE" | "SHOULD_CHANGE" | "NICE_TO_HAVE";
  from_clause_library: boolean;
  clause_library_source: string | null;
  highlight_text?: string;
}

export interface Clarification {
  id: string;
  question: string;
  clause: string;
  assign_to: string;
  highlight_text?: string;
}

export interface FinancialItem {
  item: string;
  finding: string;
  assessment: "GOOD" | "ACCEPTABLE" | "NEEDS_APPROVAL" | "CRITICAL";
  recommendation: string;
}

export interface MissingClause {
  clause_name: string;
  description: string;
  suggested_wording: string;
  importance: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  from_clause_library: boolean;
  clause_library_source: string | null;
}

export interface YellowFlag {
  item: string;
  clause: string | null;
  note: string;
  highlight_text?: string;
}

export interface PositiveFinding {
  clause: string;
  finding: string;
  highlight_text?: string;
}

export interface SectionRisk {
  clause_reference: string;
  clause_title: string;
  risk_score: number;
  risk_label: "RENDAH" | "SEDANG" | "TINGGI" | "KRITIS";
  primary_issues: string[];
}

export interface PlaybookComplianceItem {
  status: "compliant" | "needs_attention" | "non_compliant" | "not_found";
  assessment: string;
  clause_reference?: string;
  clause_text?: string;
  playbook_threshold?: string;
}

export type PlaybookCompliance = Record<string, PlaybookComplianceItem>;

export type OverallRecommendation =
  | "READY_TO_SIGN"
  | "NEEDS_REVISIONS"
  | "ESCALATE_TO_CEO_COO"
  | "DO_NOT_SIGN";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ReviewOutput {
  executive_summary: string;
  client_name: string;
  contract_type: string;
  template_used: string;
  overall_recommendation: OverallRecommendation;
  risk_level: RiskLevel;
  red_flags: RedFlag[];
  revisions: Revision[];
  clarifications: Clarification[];
  financial_review: FinancialItem[];
  missing_clauses: MissingClause[];
  yellow_flags: YellowFlag[];
  positive_findings: PositiveFinding[];
  section_risks: SectionRisk[];
  playbook_compliance: PlaybookCompliance;
}

export interface NegotiationPoint {
  id: string;
  title: string;
  clause_reference: string;
  what_to_ask: string;
  business_impact: string;
  ideal_position: string;
  fallback_position: string;
  talking_script: string;
  source_finding_ids: string[];
}

export interface NegotiationMemo {
  memo_title: string;
  overall_tone_recommendation: "cooperative" | "firm" | "cautious";
  tone_explanation: string;
  opening_statement: string;
  must_change: NegotiationPoint[];
  should_change: NegotiationPoint[];
  nice_to_discuss: NegotiationPoint[];
  do_not_raise: Array<{ id: string; title: string; reason: string }>;
  closing_guidance: string;
  red_lines: Array<{ description: string; reason: string }>;
}

/** Full `reviews` row as stored in Mike (Janus schema). */
export interface ReviewDetailRow {
  id: string;
  user_id: string | null;
  title: string | null;
  client_name: string | null;
  document_type: string | null;
  contract_filename: string | null;
  contract_text: string | null;
  contract_html: string | null;
  contract_docx_path: string | null;
  contract_redline_path: string | null;
  contract_pdf_path: string | null;
  project_context: string | null;
  review_focus: string[] | null;
  ai_output: ReviewOutput | null;
  risk_level: string | null;
  recommendation: string | null;
  coo_recommendation_override: string | null;
  coo_override_rationale: string | null;
  status: string | null;
  lifecycle_stage: string | null;
  signing_date: string | null;
  expiry_date: string | null;
  renewal_date: string | null;
  negotiation_memo: NegotiationMemo | null;
  negotiation_memo_generated_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface ReviewFeedbackRow {
  id: string;
  review_id: string;
  user_id: string | null;
  finding_type: string;
  finding_id: string;
  action: string;
  original_severity: string | null;
  adjusted_severity: string | null;
  original_text: string | null;
  edited_text: string | null;
  rationale: string | null;
  created_at: string;
}

export interface ManualCommentRow {
  id: string;
  review_id: string;
  user_id: string | null;
  user_name: string | null;
  comment_type: string;
  highlight_text: string | null;
  highlight_start: number | null;
  highlight_end: number | null;
  comment_text: string;
  suggested_text: string | null;
  parent_comment_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface ReviewDetail {
  review: ReviewDetailRow;
  feedback: ReviewFeedbackRow[];
  comments: ManualCommentRow[];
  revisionEdits: import("./contracts.redline").RevisionEditRow[];
}

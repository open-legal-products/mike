// Playbook rules (Janus `/playbook`): the dynamic rule set the AI review is
// scored against. Mike owns the table; every review sends the active rows to
// the review-contract gateway (payload mode), so an edit here changes the next
// review with no redeploy. Reads are open to any signed-in user; writes are
// admin-only — enforced by the caller through `callerIsAdmin`.

import { z } from "zod";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

export const RULE_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export interface PlaybookRuleRow {
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

/** The five fields review-contract renders into the system prompt. */
export type PromptRule = Pick<PlaybookRuleRow, "rule_number" | "title" | "description" | "thresholds" | "severity">;

// z.record accepts arrays (they are objects); the prompt renders thresholds as
// a JSON object, so reject anything that is not a plain object.
const thresholdsSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => !Array.isArray(v), { message: "thresholds harus berupa objek JSON." });

const fields = {
  rule_number: z.string().trim().min(1).max(32),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  thresholds: thresholdsSchema,
  severity: z.enum(RULE_SEVERITIES),
  is_active: z.boolean(),
};

const createSchema = z.object({
  ...fields,
  thresholds: fields.thresholds.default({}),
  severity: fields.severity.default("HIGH"),
  is_active: fields.is_active.default(true),
});
export type CreateRuleInput = z.infer<typeof createSchema>;

// Built from the undefaulted fields: `.partial()` on the create schema would
// re-apply the defaults and turn an empty patch into a full row.
const patchSchema = z
  .object({
    rule_number: fields.rule_number.optional(),
    title: fields.title.optional(),
    description: fields.description.optional(),
    thresholds: fields.thresholds.optional(),
    severity: fields.severity.optional(),
    is_active: fields.is_active.optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "Tidak ada perubahan." });
export type PatchRuleInput = z.infer<typeof patchSchema>;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid body";
}

export function parseCreateRuleBody(body: unknown): ServiceResult<CreateRuleInput> {
  const parsed = createSchema.safeParse(body);
  return parsed.success ? ok(parsed.data) : failure("validation", firstIssue(parsed.error));
}

export function parsePatchRuleBody(body: unknown): ServiceResult<PatchRuleInput> {
  const parsed = patchSchema.safeParse(body);
  return parsed.success ? ok(parsed.data) : failure("validation", firstIssue(parsed.error));
}

export async function listPlaybookRules(db: Db): Promise<ServiceResult<PlaybookRuleRow[]>> {
  const { data, error } = await db.from("playbook_rules").select("*").order("rule_number");
  if (error) return internalFailure(error);
  return ok((data ?? []) as unknown as PlaybookRuleRow[]);
}

/** Active rules in prompt order; what runReview forwards to review-contract. */
export async function listPromptRules(db: Db): Promise<PromptRule[]> {
  const { data, error } = await db
    .from("playbook_rules")
    .select("rule_number, title, description, thresholds, severity")
    .eq("is_active", true)
    .order("rule_number");
  if (error) throw new Error(`Gagal memuat aturan playbook: ${error.message}`);
  return (data ?? []) as unknown as PromptRule[];
}

const UNIQUE_VIOLATION = "23505";

export async function createPlaybookRule(db: Db, input: CreateRuleInput): Promise<ServiceResult<PlaybookRuleRow>> {
  const { data, error } = await db.from("playbook_rules").insert(input).select("*").single();
  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return failure("conflict", `Nomor aturan ${input.rule_number} sudah digunakan.`);
    }
    return internalFailure(error);
  }
  if (!data) return internalFailure(new Error("Aturan tidak tersimpan."));
  return ok(data as unknown as PlaybookRuleRow);
}

export async function updatePlaybookRule(db: Db, id: string, patch: PatchRuleInput): Promise<ServiceResult<PlaybookRuleRow>> {
  const { data, error } = await db.from("playbook_rules").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION && patch.rule_number) {
      return failure("conflict", `Nomor aturan ${patch.rule_number} sudah digunakan.`);
    }
    return internalFailure(error);
  }
  if (!data) return failure("not_found", "Aturan tidak ditemukan.");
  return ok(data as unknown as PlaybookRuleRow);
}

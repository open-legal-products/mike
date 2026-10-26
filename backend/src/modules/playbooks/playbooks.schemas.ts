import { z } from "zod";
export const clauseSchema = z.object({
    text: z.string().trim().min(1).max(20000),
    usage: z
        .enum(["illustrative", "preferred", "verbatim", "accepted", "unacceptable"])
        .default("illustrative"),
    sourceRefs: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
});
export const positionSchema = z.object({
    name: z.string().trim().min(1).max(200),
    criteria: z.string().trim().min(1).max(20000),
    sampleClauses: z.array(clauseSchema).max(30).default([]),
});
export const ruleSchema = z.object({
    id: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(300),
    concept: z.string().trim().min(1).max(20000),
    scope: z.enum(["clause", "agreement"]).default("clause"),
    required: z.boolean().default(false),
    guidance: z.string().trim().max(20000).default(""),
    standard: positionSchema.nullable().default(null),
    fallbacks: z.array(positionSchema).max(20).default([]),
    unacceptable: z.array(positionSchema).max(20).default([]),
    conditions: z.array(z.string().trim().min(1).max(2000)).max(30).default([]),
    actions: z
        .array(z.object({
        scenario: z.string().trim().max(2000).default(""),
        instruction: z.string().trim().min(1).max(5000),
    }))
        .max(20)
        .default([]),
    sourceRefs: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});
export const topicSchema = z.object({
    id: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(300),
    rules: z.array(ruleSchema).max(200),
});
export const playbookContentShape = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).default(""),
    representedParty: z.string().trim().max(300).default(""),
    documentTypes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    jurisdictions: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    rules: z.array(ruleSchema).max(200).default([]),
    topics: z.array(topicSchema).max(200).default([]),
});
export const playbookContentSchema = playbookContentShape.refine(
  (content) =>
    content.rules.length > 0 ||
    content.topics.some((topic) => topic.rules.length > 0),
  {
    message: "Add at least one rule before running a review.",
    path: ["rules"],
  },
);
// Autosave must accept an unfinished field or an empty topic. Compilation and
// review still use the strict schema above; structural limits apply to both.
export const editableClauseSchema = clauseSchema.extend({
    text: z.string().max(20000),
});
export const editablePositionSchema = positionSchema.extend({
    name: z.string().max(200),
    criteria: z.string().max(20000),
    sampleClauses: z.array(editableClauseSchema).max(30).default([]),
});
export const editableRuleSchema = ruleSchema.extend({
    name: z.string().max(300),
    concept: z.string().max(20000),
    guidance: z.string().max(20000).default(""),
    standard: editablePositionSchema.nullable().default(null),
    fallbacks: z.array(editablePositionSchema).max(20).default([]),
    unacceptable: z.array(editablePositionSchema).max(20).default([]),
});
export const editablePlaybookSchema = playbookContentShape.extend({
  name: z.string().max(200),
  description: z.string().max(2_000).default(""),
  representedParty: z.string().max(300).default(""),
  rules: z.array(editableRuleSchema).max(200).default([]),
  topics: z
    .array(
      topicSchema.extend({
        name: z.string().max(300),
        rules: z.array(editableRuleSchema).max(200),
      }),
    )
    .max(200)
    .default([]),
});
export const findingSchema = z.object({
    topicId: z.string().trim().max(100).nullable().default(null),
    ruleId: z.string().trim().max(100).nullable().default(null),
    ruleName: z.string().trim().min(1).max(300),
    status: z.enum([
        "not_applicable",
        "acceptable",
        "needs_review",
        "unacceptable",
        "missing_required",
        "outside_scope",
    ]),
    quote: z.string().trim().max(30000).default(""),
    location: z.string().trim().max(500).default(""),
    analysis: z.string().trim().min(1).max(20000),
    suggestedText: z.string().trim().max(30000).default(""),
    /** For missing_required: the end of the clause the new one follows. */
    insertAfter: z.string().trim().max(5000).default(""),
});
export const reviewSchema = z.object({
    summary: z.string().trim().min(1).max(10000),
    findings: z.array(findingSchema).max(1000),
});

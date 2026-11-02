import type { PlaybookRule } from "@/app/lib/mikeApi";

export function createPlaybookRule(index: number): PlaybookRule {
  return {
    id: `rule-${crypto.randomUUID()}`,
    name: `New rule ${index}`,
    // The content schema requires a concept even before the first edit.
    concept: "Describe the contract term this rule looks for.",
    scope: "clause",
    required: false,
    guidance: "",
    standard: null,
    fallbacks: [],
    unacceptable: [],
    conditions: [],
    actions: [],
    sourceRefs: [],
  };
}

import { modelDisplayName } from "@mike/client";
import { REASONING_LEVEL_LABELS, REASONING_LEVELS } from "@mike/ui";
import type { AssistantEvent } from "../../shared/types";

/**
 * What a run used, as "Model (reasoning): tokens", shown under a response and
 * in a subagent's details when Settings > Features > Response details is on.
 * A subagent adds the token budget its effort allowed.
 */

type Usage = { input_tokens: number; output_tokens: number };
type ResponseDetailsEvent = Extract<AssistantEvent, { type: "response_details" }>;
type DelegationEvent = Extract<AssistantEvent, { type: "delegation" }>;

const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact" });

function reasoningLabel(level: string | undefined): string | null {
    const known = REASONING_LEVELS.find((l) => l === level);
    if (!known) return null;
    return known === "none" ? "No reasoning" : REASONING_LEVEL_LABELS[known];
}

function runText(run: {
    model?: string;
    reasoning?: string;
    usage?: Usage;
    budget?: number;
}): string {
    if (!run.model) return "";
    const reasoning = reasoningLabel(run.reasoning);
    // Non-breaking spaces keep "304K tokens" and "(2.5M budget allocated)"
    // whole, so a narrow line wraps between the parts rather than inside one.
    const tokens = run.usage
        ? `: ${compactNumber.format(run.usage.input_tokens + run.usage.output_tokens)}\u00a0tokens`
        : "";
    const budget = run.budget
        ? ` (${compactNumber.format(run.budget)}\u00a0budget\u00a0allocated)`
        : "";
    return `${modelDisplayName(run.model)}${reasoning ? ` (${reasoning})` : ""}${tokens}${budget}`;
}

/**
 * Mike's own answer: "Gemini 3.8 Flash (High): 190K tokens". With subagents,
 * what they used between them follows as its own total, since they may have
 * run on other models: "Main: Gemini 3.8 Flash (High): 190K tokens.
 * Subagents total: 608K tokens."
 */
export function responseDetailsText(
    event: ResponseDetailsEvent,
    subagents?: Usage | null,
): string {
    if (!subagents) return runText(event);
    const total = compactNumber.format(subagents.input_tokens + subagents.output_tokens);
    return `Main: ${runText(event)}. Subagents\u00a0total:\u00a0${total}\u00a0tokens.`;
}

/** The tokens every subagent in an answer used, or null when none reported any. */
export function subagentUsage(events: AssistantEvent[]): Usage | null {
    const reported = events.flatMap((event) =>
        event.type === "delegation" && event.usage ? [event.usage] : [],
    );
    if (reported.length === 0) return null;
    return {
        input_tokens: reported.reduce((sum, usage) => sum + usage.input_tokens, 0),
        output_tokens: reported.reduce((sum, usage) => sum + usage.output_tokens, 0),
    };
}

/** A subagent: "Claude Haiku 4.5 (Low): 30K tokens (600K budget allocated)". */
export function subagentDetailsText(event: DelegationEvent): string {
    return runText({ ...event, budget: event.token_budget });
}

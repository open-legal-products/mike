import { completeText, type UserApiKeys } from "../../lib/llm";
import { providerFailureStatus } from "../../lib/llm/providerErrors";
import { reportError } from "../../lib/observability/sentry";
import { UserFacingError } from "../../lib/userFacingError";

const CAUSE_CHAIN_DEPTH = 8;

/** Walk an error and its `cause` chain (bounded, cycle-safe). */
function* causeChain(error: unknown): Generator<unknown> {
    const seen = new Set<object>();
    let current = error;
    for (let depth = 0; depth < CAUSE_CHAIN_DEPTH; depth++) {
        if (!current || typeof current !== "object" || seen.has(current)) return;
        seen.add(current);
        yield current;
        try {
            current = (current as { cause?: unknown }).cause;
        } catch {
            return;
        }
    }
}

/**
 * How a model call failed, reduced to what makes two failures "the same":
 * the provider's HTTP status when the provider answered, or "config" for our
 * own refusal (missing key, model not allowed). Null for anything else — a
 * bug, a failed title write, a database error.
 */
function providerFailureClass(error: unknown): number | "config" | null {
    for (const link of causeChain(error)) {
        const status = providerFailureStatus(link);
        if (status !== null) return status;
    }
    for (const link of causeChain(error)) {
        if (link instanceof UserFacingError) return "config";
    }
    return null;
}

/**
 * Handle a failed BACKGROUND title generation — the one the chat stream
 * routes start alongside the model's reply — once the reply has settled.
 *
 * `replyFailure` is what the reply threw, or null when it succeeded or was
 * aborted. The title call usually uses the same keys and provider as the
 * reply, so when both fail the same way (rejected key, no credit, an outage)
 * the reply's report already covers it and a second report only duplicated
 * it (MIKE-BACKEND-D). But the title may run on a different model or
 * provider (titleModelForChat accepts an override), and even the same
 * provider can refuse the short title call alone (a rate limit), so a title
 * failure the reply did NOT share is reported once, as a warning, under its
 * own component. Anything that is not a provider or configuration failure —
 * a failed title write, a bug — still logs at error level, because nothing
 * else will report it.
 */
export function logChatTitleFailure(
    label: string,
    error: unknown,
    replyFailure: unknown = null,
): void {
    const titleClass = providerFailureClass(error);
    if (titleClass === null) {
        console.error(label, error);
        return;
    }
    if (replyFailure !== null && providerFailureClass(replyFailure) === titleClass) {
        // The reply reported this same failure; keep the operator's log line.
        console.warn(label, error);
        return;
    }
    reportError(error, {
        level: "warning",
        tags: { component: "chat-title" },
    });
    console.warn(label, error);
}

const TITLE_FALLBACK = "Misc. Query";

function normalizeGeneratedTitle(raw: string): string {
    const title = raw
        .trim()
        .replace(/^["'`]+|["'`.,:;!?]+$/g, "")
        .trim();
    if (!title) return TITLE_FALLBACK;
    return title.slice(0, 80);
}

export async function generateAssistantChatTitle(args: {
    model: string;
    message: string;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const titleText = await completeText({
        model: args.model,
        user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. If there is not enough information to generate a title, return exactly "${TITLE_FALLBACK}". Return only the title, no quotes or punctuation.\n\nMessage: ${args.message.slice(0, 500)}`,
        maxTokens: 64,
        apiKeys: args.apiKeys,
    });
    return normalizeGeneratedTitle(titleText);
}

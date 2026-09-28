import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";

// MIKE-BACKEND-B/-C/-D/-E: one chat turn whose provider rejected the API key
// arrived in Sentry as FOUR issues sharing one request id. This drives the
// real pieces of that turn — the real Sentry client with the production
// initSentry() configuration (console bridge included), the real Gemini
// provider through the AI SDK, runLLMStream, title generation — with only the
// network answer faked, and counts the events that would leave the process.

vi.mock("../../../lib/mcpConnectors", () => ({
    buildUserMcpTools: vi.fn(async () => []),
}));

import { initSentry, resetSentryForTests } from "../../../lib/observability/sentry";
import { AssistantStreamError, runLLMStream } from "../engine/streaming";
import { generateAssistantChatTitle, logChatTitleFailure } from "../chat.title";
import { titleModelForChat } from "../../../lib/modelSelection";

// What Gemini really answers for a bad key: 400, not 401, with the reason in
// the body (see INVALID_KEY_TEXT in lib/llm/apiKeyErrors.ts).
function geminiRejectsKey(): Response {
    return new Response(
        JSON.stringify({
            error: {
                code: 400,
                message: "API key not valid. Please pass a valid API key.",
                status: "INVALID_ARGUMENT",
                details: [
                    {
                        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                        reason: "API_KEY_INVALID",
                    },
                ],
            },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
    );
}

// Supabase stand-in: thenable chain; nothing in this turn needs rows.
function emptyDb() {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq", "order", "in", "is", "limit"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve);
    // Native Google tool discovery checks each service's optional token row.
    // An unconnected user has no row, not a database lookup failure.
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    return chain;
}

const MODEL = "gemini-3-flash-preview";
const API_KEYS = { gemini: "rejected-key" };

let sent: Sentry.Event[] = [];

beforeEach(() => {
    sent = [];
    resetSentryForTests("community");
    // The production initialisation (integrations, beforeSend, install
    // shape). The DSN points at a closed local port; the envelope hook
    // records exactly what the transport would have been handed.
    expect(
        initSentry("api", {
            SENTRY_DSN: "http://public@127.0.0.1:9/1",
            SENTRY_ALLOW_IN_TESTS: "true",
            NODE_ENV: "test",
        } as NodeJS.ProcessEnv),
    ).toBe(true);
    Sentry.getClient()!.on("beforeEnvelope", (envelope) => {
        for (const [header, payload] of envelope[1]) {
            if (header.type === "event") sent.push(payload as Sentry.Event);
        }
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => geminiRejectsKey()),
    );
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await Sentry.close(0);
    resetSentryForTests();
});

/** The failing half of POST /chat, in the route's order. */
async function failedChatTurn() {
    // chat.routes.ts starts the title in parallel with the model stream and
    // only records its failure; what it means is decided after the reply.
    const titleOutcome: { failure: { error: unknown } | null } = { failure: null };
    const titlePromise = generateAssistantChatTitle({
        model: titleModelForChat(MODEL, null),
        message: "Summarise the indemnity clause",
        apiKeys: API_KEYS,
    }).catch((error) => {
        titleOutcome.failure = { error };
    });
    let streamError: unknown;
    try {
        await runLLMStream({
            apiMessages: [{ role: "user", content: "Summarise the indemnity clause" }],
            docStore: new Map(),
            docIndex: {},
            userId: "user-1",
            db: emptyDb() as never,
            write: vi.fn(),
            model: MODEL,
            apiKeys: API_KEYS as never,
            emitDone: false,
        });
    } catch (err) {
        streamError = err;
        // chat.routes.ts's outer catch.
        console.error("[chat/stream] error:", err);
    }
    await titlePromise;
    // chat.routes.ts settles the title's failure once the reply has.
    if (titleOutcome.failure) {
        logChatTitleFailure(
            "[chat/stream] failed to generate chat title",
            titleOutcome.failure.error,
            streamError ?? null,
        );
    }
    return streamError;
}

describe("one failed chat turn in Sentry", () => {
    it("files a rejected API key once, tagged, and keeps the user-facing error", async () => {
        const streamError = await failedChatTurn();
        await Sentry.flush(2000);

        // Behaviour the user sees is unchanged: a safe, coded error event.
        expect(streamError).toBeInstanceOf(AssistantStreamError);
        const events = (streamError as AssistantStreamError).events;
        expect(events.at(-1)).toMatchObject({
            type: "error",
            safe_to_display: true,
            code: "invalid_api_key",
        });

        // Before the fix: FOUR console-bridge events at level error — the
        // title's raw APICallError (D), streamText's default onError log of
        // the same (C), the classified InvalidApiKeyError (E) and the route's
        // AssistantStreamError wrapper (B).
        expect(
            sent.map((event) => [
                event.tags?.component ?? "(untagged)",
                event.tags?.capture_source,
                event.level,
            ]),
        ).toEqual([["chat-stream", "exception", "warning"]]);
        expect(sent[0]?.tags).toMatchObject({
            provider_error: "invalid_api_key",
            dependency_status: 400,
        });
    });

    // The title may run on another model or provider, or hit a rate limit the
    // reply did not. With the reply succeeding, nothing else reports it.
    it("files a title-only provider failure once, as a warning, when the reply succeeded", async () => {
        let titleFailure: unknown;
        await generateAssistantChatTitle({
            model: titleModelForChat(MODEL, null),
            message: "Summarise the indemnity clause",
            apiKeys: API_KEYS,
        }).catch((error: unknown) => {
            titleFailure = error;
        });
        expect(titleFailure).toBeDefined();
        logChatTitleFailure(
            "[chat/stream] failed to generate chat title",
            titleFailure,
            null,
        );
        await Sentry.flush(2000);

        expect(
            sent.map((event) => [
                event.tags?.component ?? "(untagged)",
                event.tags?.capture_source,
                event.level,
            ]),
        ).toEqual([["chat-title", "exception", "warning"]]);
        expect(sent[0]?.tags).toMatchObject({ dependency_status: 400 });
    });

    it("still files a genuinely different failure that follows it", async () => {
        await failedChatTurn();
        // e.g. the route then fails to save the error row.
        console.error(
            "[chat/stream] failed to save error",
            new Error("connection terminated"),
        );
        await Sentry.flush(2000);
        expect(sent).toHaveLength(2);
    });
});

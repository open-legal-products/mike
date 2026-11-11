import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getUserApiKeys, saveUserApiKey } from "../../../lib/providerCredentials/store";

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

/**
 * Gemini answering `status` with `message` — the shape of its error body.
 * `retry-after-ms` keeps the AI SDK's retries of a 429/5xx instant.
 */
function geminiAnswers(status: number, message: string): Response {
    return new Response(
        JSON.stringify({ error: { code: status, message, status: "UNAVAILABLE" } }),
        {
            status,
            headers: { "Content-Type": "application/json", "retry-after-ms": "1" },
        },
    );
}

// Supabase stand-in: thenable chain; nothing in this turn needs rows.
function emptyDb() {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq", "filter", "order", "in", "is", "limit"]) {
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

// Every initSentry() below adds one process "beforeExit" listener that
// Sentry's ProcessSession integration never removes. Production initialises
// once; this file initialises per test, so the 11th test tripped Node's
// MaxListenersExceededWarning, which the runtime-warning bridge then filed
// as an event inside whichever test was running.
let maxListeners = 0;
beforeAll(() => {
    maxListeners = process.getMaxListeners();
    process.setMaxListeners(maxListeners + 20);
});
afterAll(() => {
    process.setMaxListeners(maxListeners);
});

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

/**
 * The user's keys as the chat route gets them: the real credential store's
 * answer (the environment's keys with the user's saved rows laid over them)
 * for a user with no saved key, or with `saved.gemini` saved.
 */
async function storeKeys(saved: { gemini?: string } = {}) {
    const rows: Record<string, unknown>[] = [];
    const db = {
        from: (table: string) => {
            const q: Record<string, unknown> = {};
            for (const method of ["select", "eq", "filter"]) q[method] = () => q;
            q.upsert = async (row: Record<string, unknown>) => {
                rows.push(row);
                return { error: null };
            };
            q.maybeSingle = async () => ({ data: null, error: null });
            q.then = (resolve: (value: unknown) => unknown) =>
                Promise.resolve({
                    data: table === "user_api_keys" ? rows : [],
                    error: null,
                }).then(resolve);
            return q;
        },
    };
    if (saved.gemini) await saveUserApiKey("user-1", "gemini", saved.gemini, db as never);
    return getUserApiKeys("user-1", db as never);
}

/** The failing half of POST /chat, in the route's order. */
async function failedChatTurn(apiKeys: object = API_KEYS) {
    // chat.routes.ts starts the title in parallel with the model stream and
    // only records its failure; what it means is decided after the reply.
    const titleOutcome: { failure: { error: unknown } | null } = { failure: null };
    const titlePromise = generateAssistantChatTitle({
        model: titleModelForChat(MODEL, null),
        message: "Summarise the indemnity clause",
        apiKeys,
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
            apiKeys: apiKeys as never,
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
    it("files nothing for a rejected API key, and keeps the user-facing error", async () => {
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

        // Once FOUR console-bridge events at level error — the title's raw
        // APICallError (D), streamText's default onError log of the same
        // (C), the classified InvalidApiKeyError (E) and the route's
        // AssistantStreamError wrapper (B) — then one warning (MIKE-BACKEND-
        // 5B, -76, -85, -16). The user is told to fix the key; nothing in
        // Mike can, so nothing is sent, and no later log of the turn's
        // failure (the route's console.error above) files it either.
        expect(sent).toEqual([]);
    });

    // A revoked DEPLOYMENT key fails every user's chat, and each is told to
    // contact the administrator. The administrator hears about it once per
    // process, as a warning; the title's identical failure and the next
    // turn's are not more events. The keys come from the real credential
    // store with no saved row, so `apiKeys.gemini` IS the environment's key:
    // the shape the live recording caught being read as the user's own.
    it("keeps separate failed deployment-key turns visible", async () => {
        vi.stubEnv("GEMINI_API_KEY", "revoked-deployment-key");
        try {
            const apiKeys = await storeKeys();
            expect(apiKeys.gemini).toBe("revoked-deployment-key");
            const streamError = await failedChatTurn(apiKeys);
            await failedChatTurn(apiKeys);
            await Sentry.flush(2000);

            expect((streamError as AssistantStreamError).events.at(-1)).toMatchObject({
                type: "error",
                safe_to_display: true,
                code: "invalid_api_key",
            });
            expect(
                sent.map((event) => [event.tags?.component, event.level, event.tags?.error_kind]),
            ).toEqual([["chat-stream", "error", "chat.provider_rejected"], ["chat-stream", "error", "chat.provider_rejected"]]);
            expect(JSON.stringify(sent)).not.toContain("revoked-deployment-key");
        } finally {
            vi.unstubAllEnvs();
        }
    });

    // The same store path with the user's own key saved over the
    // environment's: their key, their fix, no event.
    it("files nothing when the store's key is the user's saved one", async () => {
        vi.stubEnv("GEMINI_API_KEY", "deployment-key");
        vi.stubEnv("USER_API_KEYS_ENCRYPTION_SECRET", "test-secret");
        try {
            const apiKeys = await storeKeys({ gemini: "rejected-user-key" });
            expect(apiKeys.gemini).toBe("rejected-user-key");
            await failedChatTurn(apiKeys);
            await Sentry.flush(2000);
            expect(sent).toEqual([]);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    // MIK-89: a provider that is busy or down is not Mike's bug. One event
    // per turn, as a warning, named by what the provider did.
    it.each([
        [429, "Resource has been exhausted (e.g. check quota).", "chat.provider_rate_limited"],
        [503, "The model is overloaded. Please try again later.", "chat.provider_unavailable"],
    ])("files a provider %i once, as a warning", async (status, message, kind) => {
        vi.stubGlobal("fetch", vi.fn(async () => geminiAnswers(status, message)));
        await failedChatTurn();
        await Sentry.flush(2000);

        expect(
            sent.map((event) => [event.tags?.component, event.level, event.tags?.error_kind]),
        ).toEqual([["chat-stream", "warning", kind]]);
        expect(sent[0]?.tags).toMatchObject({
            provider_error: "retry_exhausted",
            dependency_status: status,
        });
    });

    // The one this must not quieten: a failure nothing explains may be ours.
    it("still files an unexplained provider failure at error level", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => geminiAnswers(400, "Request contains an invalid argument.")),
        );
        await failedChatTurn();
        await Sentry.flush(2000);

        expect(
            sent.map((event) => [event.tags?.component, event.level, event.tags?.error_kind]),
        ).toEqual([["chat-stream", "error", "chat.stream_failed"]]);
    });

    // The title may run on another model or provider, or hit a rate limit the
    // reply did not. With the reply succeeding, nothing else reports it.
    it("files a title-only provider failure once, as a warning, when the reply succeeded", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => geminiAnswers(429, "Resource has been exhausted (e.g. check quota).")),
        );
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
        expect(sent[0]?.tags).toMatchObject({
            dependency_status: 429,
            operation: "chat.title",
        });
    });

    it("still files a genuinely different failure that follows it", async () => {
        await failedChatTurn();
        // e.g. the route then fails to save the error row.
        console.error(
            "[chat/stream] failed to save error",
            new Error("connection terminated"),
        );
        await Sentry.flush(2000);
        // The rejected key files nothing; the unrelated failure still does.
        expect(sent.map((event) => event.level)).toEqual(["error"]);
    });

    it("logs the title's own deadline as a warning, never an event", async () => {
        // MIKE-BACKEND-E: the 15 s title timer firing is the fallback working.
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        logChatTitleFailure(
            "[chat/stream] failed to generate chat title",
            new DOMException("Chat title timed out", "TimeoutError"),
            null,
        );
        await Sentry.flush(2000);
        expect(sent).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    // MIKE-BACKEND-88: undici's SocketError under the SDK's exhausted
    // retries was "chat.stream_failed" at error level, and the title's copy
    // of the same dropped connection was filed again by the console bridge.
    it("files a dropped connection once, as a warning, under provider_unavailable", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("terminated", {
                    cause: Object.assign(new Error("other side closed"), {
                        name: "SocketError",
                        code: "UND_ERR_SOCKET",
                    }),
                });
            }),
        );
        await failedChatTurn();
        await Sentry.flush(2000);

        // Last in the file: the SDK's retries of the stubbed fetch leave a
        // process warning (MaxListenersExceededWarning) that may land during
        // or after this test; it is its own issue, not this turn's failure.
        const turnEvents = sent.filter((event) => event.tags?.component !== "runtime-warning");
        expect(
            turnEvents.map((event) => [event.tags?.component, event.level, event.tags?.error_kind]),
        ).toEqual([["chat-stream", "warning", "chat.provider_unavailable"]]);
        expect(turnEvents[0]?.tags).toMatchObject({ failure_code: "UND_ERR_SOCKET" });
    }, 20_000);
});

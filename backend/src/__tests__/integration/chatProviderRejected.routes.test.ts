// PR #792 live recording: a revoked DEPLOYMENT key filed no Sentry event in
// a real chat turn. The credential store starts from the environment's keys
// and lays the user's saved keys over them, so with no saved key the adapter
// received ANTHROPIC_API_KEY as `apiKeys.claude`, read it as the user's own,
// and the refusal was dropped as a BYOK problem.
//
// This drives POST /chat end to end: the real router, the real credential
// store (reading user_api_keys rows from the stub database), the real
// Anthropic adapter through the AI SDK, and the real Sentry client with the
// production initSentry() configuration. Only the network answer (a 401
// from Anthropic, the shape the recorder's provider-stub.mjs sends) and the
// database are faked.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import * as Sentry from "@sentry/node";

vi.hoisted(() => {
    process.env.RATE_LIMIT_CHAT_MAX = "1000";
});

const { keyRows, providerRequests } = vi.hoisted(() => ({
    // The signed-in user's user_api_keys rows (encrypted, as saved).
    keyRows: [] as Record<string, unknown>[],
    // The x-api-key of every request that reached the provider.
    providerRequests: [] as string[],
}));

// The rows single-row reads find; memory is off, so the turn never curates.
const SINGLE_ROWS: Record<string, Record<string, unknown>> = {
    chats: { id: "chat-1", title: "Indemnity", user_id: "u1", project_id: null },
    chat_messages: { id: "message-1" },
    memory_files: { id: "memory-1", scope: "user", user_id: "u1", org_id: null, enabled: false },
};

/**
 * A chainable Supabase stand-in: user_api_keys answers with `keyRows`, a
 * single-row read with SINGLE_ROWS, every other list with no rows.
 */
function routeDb() {
    const query = (table: string) => {
        const q: Record<string, unknown> = {};
        for (const method of [
            "select", "insert", "update", "upsert", "delete", "eq", "neq", "in", "is",
            "not", "or", "lt", "gt", "gte", "lte", "filter", "range", "contains",
            "order", "limit",
        ]) {
            q[method] = vi.fn(() => q);
        }
        const one = () => Promise.resolve({ data: SINGLE_ROWS[table] ?? null, error: null });
        q.single = vi.fn(one);
        q.maybeSingle = vi.fn(one);
        q.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
            Promise.resolve({
                data: table === "user_api_keys" ? keyRows : [],
                error: null,
            }).then(resolve, reject);
        return q;
    };
    return {
        from: vi.fn(query),
        rpc: vi.fn(async () => ({ data: null, error: null })),
        auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    };
}

vi.mock("../../lib/supabase", () => ({ createServerSupabase: vi.fn(() => routeDb()) }));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/memory/schedule", () => ({
    beginMemoryConversationTurn: vi.fn(async () => ({ activityId: "activity-1" })),
    releaseMemoryConversationTurn: vi.fn(async () => undefined),
    scheduleMemoryConsolidation: vi.fn(async () => ({ job_id: "job-1", generation: 1 })),
}));

vi.mock("../../lib/mcpConnectors", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/mcpConnectors")>()),
    buildUserMcpTools: vi.fn(async () => []),
}));

// The model settings are the user's profile and preferences; the KEYS are
// the real credential store's answer for this user, read from the stub's
// user_api_keys rows (the path the live recording took).
vi.mock("../../modules/user/user.settings", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../modules/user/user.settings")>();
    const { getEffectiveApiKeys } = await import("../../lib/providerCredentials/index.js");
    const { DEFAULT_WEB_SEARCH_SETTINGS } = await import("../../lib/webSearch/index.js");
    return {
        ...actual,
        getUserModelSettings: vi.fn(async (userId: string, db: never) => ({
            legal_research_us: false,
            web_search: DEFAULT_WEB_SEARCH_SETTINGS,
            title_model: null,
            tabular_model: null,
            last_selected_chat_model: null,
            last_selected_reasoning_level: null,
            api_keys: await getEffectiveApiKeys(userId, null, db),
        })),
        persistLastSelectedChatModel: vi.fn(async () => null),
        persistLastSelectedReasoningLevel: vi.fn(async () => null),
    };
});

import { app } from "../../app";
import { resetAssistantTurnRunsForTests } from "../../lib/assistantTurnRuns";
import { initSentry, resetSentryForTests } from "../../lib/observability/sentry";
import { saveUserApiKey } from "../../lib/providerCredentials/store";

const DEPLOYMENT_KEY = "sk-ant-deployment-DEPLOY";
const USER_KEY = "sk-ant-user-USERKY";

/** What Anthropic answers for a revoked key. */
function anthropicRejectsKey(): Response {
    return new Response(
        JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        { status: 401, headers: { "content-type": "application/json", "request-id": "req_stub_1" } },
    );
}

let sent: Sentry.Event[] = [];

// One beforeExit listener per initSentry() (see chatTurnSentryEvents.test.ts).
let maxListeners = 0;
beforeAll(() => {
    maxListeners = process.getMaxListeners();
    process.setMaxListeners(maxListeners + 20);
});
afterAll(() => {
    process.setMaxListeners(maxListeners);
});

beforeEach(() => {
    resetAssistantTurnRunsForTests();
    keyRows.length = 0;
    providerRequests.length = 0;
    sent = [];
    vi.stubEnv("ANTHROPIC_API_KEY", DEPLOYMENT_KEY);
    vi.stubEnv("USER_API_KEYS_ENCRYPTION_SECRET", "test-secret");
    resetSentryForTests("community");
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
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (!/api\.anthropic\.com\/v1\/messages$/.test(url)) {
                throw new Error(`Unexpected network request: ${url}`);
            }
            providerRequests.push(new Headers(init?.headers).get("x-api-key") ?? "");
            return anthropicRejectsKey();
        }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await Sentry.close(0);
    resetSentryForTests();
});

async function chatTurn() {
    const res = await request(app)
        .post("/chat")
        .set("Authorization", "Bearer test")
        .send({
            chat_id: "chat-1",
            model: "claude-sonnet-5-5",
            messages: [{ role: "user", content: "hello" }],
        });
    expect(res.status).toBe(200);
    // The user is told to fix the key either way.
    expect(res.text).toContain('"code":"invalid_api_key"');
    return res;
}

function rejectedKeyEvents() {
    return sent
        .filter((event) => event.tags?.error_kind === "chat.provider_rejected")
        .map((event) => [event.tags?.component, event.level]);
}

describe("POST /chat when Anthropic rejects the key", () => {
    it("reports each failed deployment-key turn before repeat sampling", async () => {
        await chatTurn();
        await chatTurn();
        await Sentry.flush(2000);

        // No saved key: the store's answer is the environment's key.
        expect(providerRequests).toEqual([DEPLOYMENT_KEY, DEPLOYMENT_KEY]);
        expect(rejectedKeyEvents()).toEqual([["chat-stream", "error"], ["chat-stream", "error"]]);
        expect(sent).toHaveLength(2);
        expect(JSON.stringify(sent)).not.toContain(DEPLOYMENT_KEY);
    });

    it("files nothing for the user's own key", async () => {
        await saveUserApiKey("u1", "claude", USER_KEY, {
            from: () => ({
                upsert: async (row: Record<string, unknown>) => {
                    keyRows.push(row);
                    return { error: null };
                },
            }),
        } as never);

        await chatTurn();
        await Sentry.flush(2000);

        expect(providerRequests).toEqual([USER_KEY]);
        expect(sent).toEqual([]);
        expect(console.warn).toHaveBeenCalledWith(
            "[chat/stream] model account refused",
            expect.anything(),
        );
    });
});

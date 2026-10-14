import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamChatParams, StreamChatResult } from "../../../../lib/llm/types";

// The stub stands in for the real adapter, so it carries the real adapter's
// signature: that is what lets the assertions below read `mock.calls[n][0]`
// as a StreamChatParams instead of an untyped tuple.
const { streamChatWithTools } = vi.hoisted(() => ({
    streamChatWithTools: vi.fn<
        (params: StreamChatParams) => Promise<StreamChatResult>
    >(async () => ({ fullText: "" })),
}));

// Keep the real model catalog/constants but stub the adapter dispatch so no
// provider SDK is touched; the assertion is which model reaches the adapter.
vi.mock("../../../../lib/llm", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
    streamChatWithTools: (params: StreamChatParams) =>
        streamChatWithTools(params),
}));

vi.mock("../../../../lib/mcpConnectors", () => ({
    buildUserMcpTools: vi.fn(async () => []),
}));

import { toProviderStreamError } from "../../../../lib/llm/providerErrors";

import { AssistantStreamError, runLLMStream } from "../streaming";

// Supabase mock that only has to serve getUserRouterModels' query chain.
function routerModelsDb(
    rows: { model_id: string }[],
    error: unknown = null,
) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq", "order"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: rows, error }).then(resolve, reject);
    return chain;
}

// NOTE: the chain mock is thenable, so an async function must never `return`
// it directly (await would unwrap it). Callers build the db and pass it in.
async function runStreamWithModel(
    db: Record<string, unknown>,
    model: string,
    apiKeys?: Record<string, string | null>,
    orgId?: string,
) {
    await runLLMStream({
        apiMessages: [{ role: "user", content: "hello" }],
        // docStore is a Map keyed by doc id; nothing in these cases resolves a
        // document, so an empty one is enough — but it has to be a real Map.
        docStore: new Map(),
        docIndex: {},
        userId: "user-1",
        db: db as never,
        write: vi.fn(),
        model,
        apiKeys: apiKeys as never,
        orgId,
    });
}

// A member of org-1, which holds an OpenRouter key and has approved one
// model for it; the member's own saved list names a different one.
function organizationDb() {
    const tables: Record<string, Record<string, unknown>[]> = {
        org_members: [{ org_id: "org-1", user_id: "user-1" }],
        org_api_keys: [{ org_id: "org-1", provider: "openrouter" }],
        org_router_models: [
            { org_id: "org-1", router: "openrouter", model_id: "firm/approved" },
        ],
        user_router_models: [
            { user_id: "user-1", router: "openrouter", model_id: "mine/own" },
        ],
    };
    return {
        from: vi.fn((table: string) => {
            const filters: [string, unknown][] = [];
            const rows = () =>
                (tables[table] ?? []).filter((row) =>
                    filters.every(([column, value]) => row[column] === value),
                );
            const query = {
                select: () => query,
                is: () => query,
                order: () => query,
                eq(column: string, value: unknown) {
                    filters.push([column, value]);
                    return query;
                },
                maybeSingle: async () => ({
                    data: rows()[0] ?? null,
                    error: null,
                }),
                then: (
                    resolve: (value: unknown) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) =>
                    Promise.resolve({ data: rows(), error: null }).then(
                        resolve,
                        reject,
                    ),
            };
            return query;
        }),
    };
}

function tablesQueried(db: Record<string, unknown>): unknown[] {
    return (db.from as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0],
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    streamChatWithTools.mockResolvedValue({ fullText: "" });
});

describe("runLLMStream router-model allowlist", () => {
    it("retains a provider failure internally without adding its cause to stream events", async () => {
        const original = Object.assign(new Error("private-provider-response"), {
            statusCode: 401,
            responseBody: "private-provider-response",
        });
        const mapped = toProviderStreamError(original, { label: "Gemini", modelId: "gemini-2.5-pro" });
        streamChatWithTools.mockRejectedValueOnce(mapped);
        const error = await runStreamWithModel(routerModelsDb([]), "claude-fable-5-1").catch((err: unknown) => err);
        expect(error).toBeInstanceOf(AssistantStreamError);
        if (!(error instanceof AssistantStreamError)) throw error;
        expect(error.cause).toBe(mapped);
        expect(mapped.cause).toBe(original);
        expect(error.events).toContainEqual(expect.objectContaining({ type: "error", code: "invalid_api_key", safe_to_display: true }));
        expect(JSON.stringify(error.events)).not.toContain("private-provider-response");
    });

    it("passes a saved router model through to the adapter", async () => {
        const db = routerModelsDb([{ model_id: "allowed/model" }]);
        await runStreamWithModel(db, "openrouter/allowed/model");

        expect(streamChatWithTools).toHaveBeenCalledWith(
            expect.objectContaining({ model: "openrouter/allowed/model" }),
        );
        expect(tablesQueried(db)).toContain("user_router_models");
    });

    it("fails the request for a router model the user never saved", async () => {
        // The request NAMED this model. Answering with a different one would
        // silently attribute the reply to a model the user did not choose, so
        // the stream errors with an actionable message instead.
        const db = routerModelsDb([{ model_id: "allowed/model" }]);

        await expect(
            runStreamWithModel(db, "openrouter/pricy/frontier-model"),
        ).rejects.toThrow(
            /openrouter\/pricy\/frontier-model is not in your saved OpenRouter models .* Settings → Bring Your Own Keys and add it under Model Selections/,
        );
        expect(streamChatWithTools).not.toHaveBeenCalled();
    });

    it("runs a model the organization approved for its key, in the organization's work", async () => {
        // The member never saved this model themselves. Judging it against
        // their own list would fail a turn the selection step just allowed.
        await runStreamWithModel(
            organizationDb(),
            "openrouter/firm/approved",
            undefined,
            "org-1",
        );

        expect(streamChatWithTools).toHaveBeenCalledWith(
            expect.objectContaining({ model: "openrouter/firm/approved" }),
        );
    });

    it("does not let a member's own list widen what the organization's key runs", async () => {
        await expect(
            runStreamWithModel(
                organizationDb(),
                "openrouter/mine/own",
                undefined,
                "org-1",
            ),
        ).rejects.toThrow(/organization's saved OpenRouter models/);
        expect(streamChatWithTools).not.toHaveBeenCalled();
    });

    it("keeps the organization's list out of personal work", async () => {
        await expect(
            runStreamWithModel(organizationDb(), "openrouter/firm/approved"),
        ).rejects.toThrow(/your saved OpenRouter models/);
        expect(streamChatWithTools).not.toHaveBeenCalled();
    });

    it("also fails for non-members when the user brings their own key", async () => {
        const db = routerModelsDb([]);

        await expect(
            runStreamWithModel(db, "vercel/pricy/frontier-model", {
                vercel: "user-byok-key",
            }),
        ).rejects.toThrow(
            /is not in your saved Vercel AI Gateway models/,
        );
        expect(streamChatWithTools).not.toHaveBeenCalled();
    });

    it("surfaces the rejection through the stream's error event", async () => {
        const error = await runStreamWithModel(
            routerModelsDb([]),
            "openrouter/pricy/frontier-model",
        ).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(AssistantStreamError);
        // The assertion above already failed the test if this is not one, so
        // the narrow is type-level only — but it is the narrow, not a cast,
        // that makes `.events` readable.
        if (!(error instanceof AssistantStreamError)) throw error;
        expect(error.events).toContainEqual(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining(
                    "Settings → Bring Your Own Keys and add it under Model Selections",
                ),
            }),
        );
    });

    it("reports a selection-lookup failure through the stream's error path", async () => {
        // A database blip while reading user_router_models must surface as a
        // normal SSE stream error (error event + AssistantStreamError), not as
        // a bare rejection thrown before the stream's error machinery exists.
        const db = routerModelsDb([], {
            code: "57014",
            message: "canceling statement due to statement timeout",
        });

        await expect(
            runStreamWithModel(db, "openrouter/allowed/model"),
        ).rejects.toBeInstanceOf(AssistantStreamError);
        expect(streamChatWithTools).not.toHaveBeenCalled();

        const error = await runStreamWithModel(
            routerModelsDb([], {
                code: "57014",
                message: "canceling statement due to statement timeout",
            }),
            "openrouter/allowed/model",
        ).catch((err: unknown) => err);
        // Same narrow as above: anything other than an AssistantStreamError
        // fails this case either way, and the `instanceof` is what lets the
        // events assertion see the class's shape.
        if (!(error instanceof AssistantStreamError)) throw error;
        expect(error.events).toContainEqual(
            expect.objectContaining({ type: "error" }),
        );
    });

    it("does not consult the router selection for first-party models", async () => {
        const db = routerModelsDb([]);
        await runStreamWithModel(db, "claude-fable-5-1");

        expect(streamChatWithTools).toHaveBeenCalledWith(
            expect.objectContaining({ model: "claude-fable-5-1" }),
        );
        expect(tablesQueried(db)).not.toContain("user_router_models");
    });
});

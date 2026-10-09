import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUserApiKeys, guardedFetch } = vi.hoisted(() => ({
    getUserApiKeys: vi.fn(),
    guardedFetch: vi.fn(),
}));

vi.mock("../../../lib/mcp/client", () => ({ guardedFetch }));

vi.mock("../../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        next();
    },
}));

vi.mock("../../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({ from: vi.fn() })),
}));

vi.mock("../../user/user.apiKeyStore", () => ({
    getUserApiKeys: (...args: unknown[]) => getUserApiKeys(...args),
}));

import { modelsRouter } from "../models.routes";
import { resetModelRegistryCache } from "../../../lib/llm/registry";
import {
    INTERNAL_ERROR_CODE,
    INTERNAL_ERROR_MESSAGE,
} from "../../../lib/httpError";

const app = express();
app.use("/models", modelsRouter);

describe("GET /models/configured", () => {
    const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ openai: "user-openai-key" });
        process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({
            models: [
                {
                    id: "local-qwen",
                    label: "Local Qwen",
                    provider: "openai-compatible",
                    location: "local",
                    baseUrl: "http://localhost:8000/v1",
                },
                {
                    id: "cloud-user-key",
                    provider: "openai-compatible",
                    location: "cloud",
                    baseUrl: "https://models.example.test/v1",
                    apiKeyProvider: "openai",
                },
                {
                    id: "cloud-missing-env",
                    provider: "openai-compatible",
                    location: "cloud",
                    baseUrl: "https://missing.example.test/v1",
                    apiKeyEnv: "MISSING_CONFIGURED_MODEL_KEY",
                },
            ],
        });
        delete process.env.MISSING_CONFIGURED_MODEL_KEY;
        resetModelRegistryCache();
    });

    afterEach(() => {
        if (originalConfig === undefined) {
            delete process.env.MIKE_MODEL_CONFIG_JSON;
        } else {
            process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
        }
        resetModelRegistryCache();
        vi.clearAllMocks();
    });

    it("returns only usable models without exposing endpoint credentials", async () => {
        const response = await request(app).get("/models/configured");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            {
                id: "local-qwen",
                label: "Local Qwen",
                group: "Configured",
                location: "local",
                source: "Configured",
            },
            {
                id: "cloud-user-key",
                label: "cloud-user-key",
                group: "Configured",
                location: "cloud",
                source: "Configured",
            },
        ]);
        expect(response.text).not.toContain("baseUrl");
        expect(response.text).not.toContain("user-openai-key");
    });
});

describe("GET /models/openrouter", () => {
    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ openrouter: "or-user-key" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        delete process.env.OPENROUTER_BASE_URL;
    });

    it("honors OPENROUTER_BASE_URL like the chat adapter", async () => {
        process.env.OPENROUTER_BASE_URL = "http://localhost:4141/api/v1/";
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ data: [] }), { status: 200 }),
            );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(200);
        expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
            /^http:\/\/localhost:4141\/api\/v1\/models\?/,
        );
    });

    it("requires a configured OpenRouter key", async () => {
        getUserApiKeys.mockResolvedValue({});
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("missing_api_key");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns the authenticated OpenRouter catalog in selector shape", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: "anthropic/claude-sonnet-4.5",
                            name: "Claude Sonnet 4.5",
                            pricing: {
                                prompt: "0.000003",
                                completion: "0.000015",
                            },
                        },
                        { id: "openai/gpt-5.4" },
                        { id: null, name: "Invalid" },
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            {
                id: "anthropic/claude-sonnet-4.5",
                label: "Claude Sonnet 4.5",
                pricing: { input: "0.000003", output: "0.000015" },
            },
            { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("https://openrouter.ai/api/v1/models?"),
            { headers: { Authorization: "Bearer or-user-key" } },
        );
    });

    it("does not expose upstream authentication failures as a success", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    new Response("invalid key", { status: 401 }),
                ),
        );

        const response = await request(app).get("/models/openrouter");

        expect(response.status).toBe(502);
        expect(response.body).toEqual({
            code: INTERNAL_ERROR_CODE,
            detail: INTERNAL_ERROR_MESSAGE,
        });
        expect(response.text).not.toContain("invalid key");
    });
});

describe("GET /models/vercel", () => {
    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ vercel: "vercel-user-key" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("requires a configured Vercel AI Gateway key", async () => {
        getUserApiKeys.mockResolvedValue({});
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/vercel");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("missing_api_key");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns text, tool-capable models from Vercel's public catalog", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        data: [
                            {
                                id: "anthropic/claude-sonnet-4.5",
                                name: "Claude Sonnet 4.5",
                                type: "language",
                                tags: ["tool-use"],
                                modalities: { output: ["text"] },
                                pricing: {
                                    input: "0.000003",
                                    output: "0.000015",
                                    varies_by_provider: true,
                                },
                            },
                            {
                                id: "openai/gpt-5.4",
                                type: "language",
                                supported_parameters: ["tools"],
                                pricing: {
                                    input: "0.00000125",
                                    output: "0.00001",
                                    input_tiers: [
                                        { cost: "0.00000125", min: 0 },
                                    ],
                                },
                            },
                            {
                                id: "image/model",
                                type: "image",
                                modalities: { output: ["image"] },
                            },
                            {
                                id: "text/no-tools",
                                type: "language",
                                modalities: { output: ["text"] },
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    },
                ),
            ),
        );

        const response = await request(app).get("/models/vercel");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            {
                id: "anthropic/claude-sonnet-4.5",
                label: "Claude Sonnet 4.5",
                pricing: {
                    input: "0.000003",
                    output: "0.000015",
                    variesByProvider: true,
                },
            },
            {
                id: "openai/gpt-5.4",
                label: "openai/gpt-5.4",
                pricing: {
                    input: "0.00000125",
                    output: "0.00001",
                    tiered: true,
                },
            },
        ]);
        expect(fetch).toHaveBeenCalledWith(
            "https://ai-gateway.vercel.sh/v1/models",
        );
    });
});

describe("GET /models/opencode-go", () => {
    beforeEach(() => {
        getUserApiKeys.mockResolvedValue({ "opencode-go": "oc-user-key" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        delete process.env.OPENCODE_GO_BASE_URL;
    });

    it("requires a configured OpenCode Go key", async () => {
        getUserApiKeys.mockResolvedValue({});
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/opencode-go");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("missing_api_key");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns supported Chat Completions and Messages models with the key server-side", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        // Qwen and MiniMax use Anthropic Messages; GPT uses the
                        // unsupported Responses protocol.
                        { id: "qwen3.8-max", name: "Qwen3.8 Max" },
                        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
                        { id: "minimax-m3", name: "MiniMax M3" },
                        { id: "glm-5.3", name: "GLM-5.3" },
                        { id: "qwen3.8-max", name: "Qwen3.8 Max (updated)" },
                        { id: "kimi-k3" },
                        // The upstream response has no protocol metadata, so
                        // unknown future models must fail closed too.
                        { id: "future-model", name: "Future Model" },
                        { id: "bad id" },
                        { id: "   " },
                        null,
                    ],
                }),
                {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                },
            ),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/opencode-go");

        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            { id: "glm-5.3", label: "GLM-5.3" },
            { id: "kimi-k3", label: "kimi-k3" },
            { id: "minimax-m3", label: "MiniMax M3" },
            { id: "qwen3.8-max", label: "Qwen3.8 Max (updated)" },
        ]);
        expect(fetchMock).toHaveBeenCalledWith(
            "https://opencode.ai/zen/go/v1/models",
            { headers: { Authorization: "Bearer oc-user-key" } },
        );
        // The user's key must never reach the browser.
        expect(JSON.stringify(response.body)).not.toContain("oc-user-key");
    });

    it("honors OPENCODE_GO_BASE_URL like the chat adapter", async () => {
        process.env.OPENCODE_GO_BASE_URL = "http://localhost:4242/v1/";
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ data: [] }), { status: 200 }),
            );
        vi.stubGlobal("fetch", fetchMock);

        const response = await request(app).get("/models/opencode-go");

        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            "http://localhost:4242/v1/models",
        );
    });

    it("reports an upstream failure as a bad gateway", async () => {
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response("nope", { status: 401 })),
        );

        const response = await request(app).get("/models/opencode-go");

        expect(response.status).toBe(502);
        expect(response.body).toEqual({
            code: INTERNAL_ERROR_CODE,
            detail: INTERNAL_ERROR_MESSAGE,
        });
        expect(response.text).not.toContain("nope");
        expect(consoleError).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });
});

describe("GET /models/bedrock", () => {
    const fetchMock = vi.fn();
    const arn = "arn:aws:bedrock:us-east-1::foundation-model/test.chat-v1";
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
        getUserApiKeys.mockResolvedValue({ bedrock: "private-key", providerSettings: { bedrock: { region: "us-east-1" } } });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

    it("uses the user's key and region, filters non-text models and paginates profiles", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ modelSummaries: [
            { modelId: "test.chat-v1", modelArn: arn, modelName: "Chat", outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
            { modelId: "image", outputModalities: ["IMAGE"], inferenceTypesSupported: ["ON_DEMAND"] },
            { modelId: "bad id", outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
        ] })).mockResolvedValueOnce(Response.json({ inferenceProfileSummaries: [
            { inferenceProfileId: "us.chat", inferenceProfileName: "Cross-region Chat", status: "ACTIVE", models: [{ modelArn: arn.replace("us-east-1", "us-west-2") }] },
            { inferenceProfileId: "inactive", status: "INACTIVE", models: [{ modelArn: arn }] },
        ], nextToken: "next+page" })).mockResolvedValueOnce(Response.json({ inferenceProfileSummaries: [
            { inferenceProfileId: "us.chat", inferenceProfileName: "Cross-region Chat", status: "ACTIVE", models: [{ modelArn: arn }] },
        ] }));
        const response = await request(app).get("/models/bedrock");
        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([{ id: "test.chat-v1", label: "Chat" }, { id: "us.chat", label: "Cross-region Chat" }]);
        expect(fetchMock.mock.calls[0][0]).toBe("https://bedrock.us-east-1.amazonaws.com/foundation-models?byOutputModality=TEXT");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer private-key" }, redirect: "error" });
        expect(fetchMock.mock.calls[2][0]).toContain("nextToken=next%2Bpage");
        expect(getUserApiKeys).toHaveBeenCalledWith("user-1", expect.anything());
        expect(JSON.stringify(response.body)).not.toContain("private-key");
    });

    it("requires a saved region and never sends an invalid region upstream", async () => {
        getUserApiKeys.mockResolvedValue({ bedrock: "private-key", providerSettings: { bedrock: { region: "evil.example/path" } } });
        const response = await request(app).get("/models/bedrock");
        expect(response.status).toBe(422);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns a safe failure for provider permission errors", async () => {
        fetchMock.mockResolvedValue(new Response("private-key internal detail", { status: 403 }));
        const response = await request(app).get("/models/bedrock");
        expect(response.status).toBe(502);
        expect(JSON.stringify(response.body)).not.toContain("private-key");
    });

    // PR #608 regression: with no key of their own, every user lists models
    // on the DEPLOYMENT's AWS account — including its application inference
    // profiles, whose ids/ARNs carry the operator's account id and names.
    it("lists only foundation models and system profiles on the deployment's key", async () => {
        vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "operator-key");
        vi.stubEnv("BEDROCK_AWS_REGION", "us-east-1");
        getUserApiKeys.mockResolvedValue({ bedrock: "operator-key", providerSettings: { bedrock: { region: "us-east-1" } } });
        const operatorArn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6";
        fetchMock.mockResolvedValueOnce(Response.json({ modelSummaries: [
            { modelId: "test.chat-v1", modelArn: arn, modelName: "Chat", outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
        ] })).mockResolvedValueOnce(Response.json({ inferenceProfileSummaries: [
            { inferenceProfileId: "us.chat", inferenceProfileName: "Cross-region Chat", type: "SYSTEM_DEFINED", status: "ACTIVE", models: [{ modelArn: arn }] },
            { inferenceProfileId: "a1b2c3d4e5f6", inferenceProfileArn: operatorArn, inferenceProfileName: "Acme litigation team", type: "APPLICATION", status: "ACTIVE", models: [{ modelArn: arn }] },
            { inferenceProfileId: operatorArn, inferenceProfileName: "Acme by ARN", status: "ACTIVE", models: [{ modelArn: arn }] },
        ] }));
        const response = await request(app).get("/models/bedrock");
        vi.unstubAllEnvs();
        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([{ id: "test.chat-v1", label: "Chat" }, { id: "us.chat", label: "Cross-region Chat" }]);
        expect(JSON.stringify(response.body)).not.toMatch(/123456789012|a1b2c3d4e5f6|Acme/);
    });

    it("still lists a user's own application profiles on their own key", async () => {
        const ownArn = "arn:aws:bedrock:us-east-1:210987654321:application-inference-profile/own";
        fetchMock.mockResolvedValueOnce(Response.json({ modelSummaries: [
            { modelId: "test.chat-v1", modelArn: arn, modelName: "Chat", outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"] },
        ] })).mockResolvedValueOnce(Response.json({ inferenceProfileSummaries: [
            { inferenceProfileId: "own", inferenceProfileArn: ownArn, inferenceProfileName: "My profile", type: "APPLICATION", status: "ACTIVE", models: [{ modelArn: arn }] },
        ] }));
        const response = await request(app).get("/models/bedrock");
        expect(response.body.models).toContainEqual({ id: "own", label: "My profile" });
    });

    it("rejects repeated pagination tokens instead of hanging", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ modelSummaries: [] }))
            .mockResolvedValue(Response.json({ inferenceProfileSummaries: [], nextToken: "repeat" }));
        const response = await request(app).get("/models/bedrock");
        expect(response.status).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});

describe("GET /models/xai", () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
        getUserApiKeys.mockResolvedValue({ xai: "private-key" });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

    it("lists chat models with the user's key and drops media models and unusable ids", async () => {
        fetchMock.mockResolvedValue(Response.json({ data: [
            { id: "grok-4.3" },
            { id: "grok-4.20-0309-reasoning" },
            { id: "grok-imagine-image" },
            { id: "grok-imagine-video" },
            { id: "bad id" },
            { id: 7 },
            { id: "grok-4.3" },
        ] }));
        const response = await request(app).get("/models/xai");
        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            { id: "grok-4.20-0309-reasoning", label: "grok-4.20-0309-reasoning" },
            { id: "grok-4.3", label: "grok-4.3" },
        ]);
        expect(fetchMock.mock.calls[0][0]).toBe("https://api.x.ai/v1/models");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer private-key" } });
        expect(JSON.stringify(response.body)).not.toContain("private-key");
    });

    it("answers 422 without a key and a safe 502 when xAI fails", async () => {
        getUserApiKeys.mockResolvedValueOnce({});
        expect((await request(app).get("/models/xai")).status).toBe(422);
        expect(fetchMock).not.toHaveBeenCalled();

        fetchMock.mockResolvedValue(new Response("private-key internal detail", { status: 401 }));
        const failed = await request(app).get("/models/xai");
        expect(failed.status).toBe(502);
        expect(JSON.stringify(failed.body)).not.toContain("private-key");
    });
});

describe("GET /models/custom", () => {
    const fetchMock = vi.fn();
    const apiKeys = { custom: "private-key", providerSettings: { custom: { baseUrl: "https://llm.example.com/v1" } } };
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
        guardedFetch.mockReset();
        getUserApiKeys.mockResolvedValue(apiKeys);
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

    it("reads the endpoint's model list through the guarded fetch only", async () => {
        guardedFetch.mockResolvedValue(Response.json({ data: [{ id: "llama-4-70b" }, { id: "deepseek/deepseek-v4" }] }));
        const response = await request(app).get("/models/custom");
        expect(response.status).toBe(200);
        expect(response.body.models).toEqual([
            { id: "deepseek/deepseek-v4", label: "deepseek/deepseek-v4" },
            { id: "llama-4-70b", label: "llama-4-70b" },
        ]);
        expect(guardedFetch.mock.calls[0][0]).toBe("https://llm.example.com/v1/models");
        expect(guardedFetch.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer private-key" } });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never calls a saved base URL that is not public https", async () => {
        getUserApiKeys.mockResolvedValue({ custom: "private-key", providerSettings: { custom: { baseUrl: "https://169.254.169.254/latest" } } });
        const response = await request(app).get("/models/custom");
        expect(response.status).toBe(422);
        expect(guardedFetch).not.toHaveBeenCalled();
    });

    it("returns a safe failure when the endpoint has no model list or is blocked", async () => {
        guardedFetch.mockResolvedValueOnce(new Response("private-key <html>not found</html>", { status: 404 }));
        const missing = await request(app).get("/models/custom");
        expect(missing.status).toBe(502);
        expect(JSON.stringify(missing.body)).not.toContain("private-key");

        guardedFetch.mockRejectedValueOnce(new Error("MCP server URL resolves to a blocked network address."));
        const blocked = await request(app).get("/models/custom");
        expect(blocked.status).toBe(502);
        expect(JSON.stringify(blocked.body)).not.toContain("blocked network");
    });
});

describe("catalog loaders separate Mike's own failures from the provider's", () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        fetchMock.mockReset();
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

    it.each(["bedrock", "xai", "custom"])("answers 500, not 502, when reading the %s key fails", async (provider) => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        getUserApiKeys.mockRejectedValue(new Error("database unavailable"));
        const response = await request(app).get(`/models/${provider}`);
        expect(response.status).toBe(500);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(guardedFetch).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it("lists Bedrock models from the region's own partition host", async () => {
        getUserApiKeys.mockResolvedValue({ bedrock: "private-key", providerSettings: { bedrock: { region: "us-iso-east-1" } } });
        fetchMock.mockResolvedValueOnce(Response.json({ modelSummaries: [] }))
            .mockResolvedValueOnce(Response.json({ inferenceProfileSummaries: [] }));
        const response = await request(app).get("/models/bedrock");
        expect(response.status).toBe(200);
        expect(fetchMock.mock.calls[0][0]).toBe("https://bedrock.us-iso-east-1.c2s.ic.gov/foundation-models?byOutputModality=TEXT");
    });
});

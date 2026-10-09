/**
 * Cross-package drift guard: the Word add-in mirrors the web app's model
 * catalog by hand (word-addin/src/taskpane/lib/modelCatalog.ts) until both
 * clients share one package. These tests import BOTH copies so a hand-edit
 * that drifts them apart fails CI instead of shipping two different pickers.
 */
import { describe, expect, it } from "vitest";
import {
    MODELS,
    DEFAULT_MODEL_ID,
    LEGACY_MODEL_IDS,
    canonicalModelId,
    modelDisplayName,
    openCodeGoModelOptions,
    openRouterModelOptions,
    vercelModelOptions,
} from "../app/components/assistant/ModelToggle";
import {
    STATIC_MODELS,
    DEFAULT_MODEL_ID as ADDIN_DEFAULT_MODEL_ID,
    LEGACY_MODEL_IDS as ADDIN_LEGACY_MODEL_IDS,
    canonicalModelId as addinCanonicalModelId,
    isAllowedModelId as addinIsAllowedModelId,
    isModelAvailable as addinIsModelAvailable,
    modelDisplayName as addinModelDisplayName,
    openCodeGoModelOptions as addinOpenCodeGoModelOptions,
    openRouterModelOptions as addinOpenRouterModelOptions,
    vercelModelOptions as addinVercelModelOptions,
} from "../../../word-addin/src/taskpane/lib/modelCatalog";
import type { ApiKeyStatus } from "../../../word-addin/src/taskpane/types";
import { isModelAvailable as webIsModelAvailable } from "../app/lib/modelAvailability";
import { isAllowedModelId as webIsAllowedModelId } from "../app/hooks/useSelectedModel";
import type { ApiKeyState } from "../app/lib/mikeApi";
import {
    CLAUDE_MAIN_MODELS,
    GEMINI_MAIN_MODELS,
    OPENAI_MAIN_MODELS,
    MISTRAL_MAIN_MODELS,
    LEGACY_MODEL_IDS as BACKEND_LEGACY_MODEL_IDS,
    reasoningLevelsForModel as backendReasoningLevels,
} from "../../../backend/src/lib/llm/models";
import { reasoningLevelsForModel } from "../shared/ui/ModelToggleUI";
import { routerModelOptions as webRouterModelOptions } from "../app/components/assistant/ModelToggle";
import {
    ROUTER_PROFILE_FIELDS as WEB_ROUTER_PROFILE_FIELDS,
    ROUTER_SLUGS as WEB_ROUTER_SLUGS,
} from "../app/lib/routerModels";
import {
    ROUTER_PROFILE_FIELDS as ADDIN_ROUTER_PROFILE_FIELDS,
    ROUTER_SLUGS as ADDIN_ROUTER_SLUGS,
    routerModelOptions as addinRouterModelOptions,
} from "../../../word-addin/src/taskpane/lib/modelCatalog";
import { readFileSync } from "node:fs";
import path from "node:path";

// The backend's router list sits in a module that also talks to the
// database, which this package cannot import. Read the list from its source
// instead: the declaration is a plain array of string literals.
function backendRouterSlugs(): string[] {
    const source = readFileSync(
        path.resolve(__dirname, "../../../backend/src/lib/routerModels.ts"),
        "utf8",
    );
    const declaration = /export const ROUTER_SLUGS[^=]*=\s*\[([^\]]*)\]/.exec(
        source,
    );
    if (!declaration) throw new Error("backend ROUTER_SLUGS not found");
    return [...declaration[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("word add-in catalog parity", () => {
    it("keeps both clients aligned with backend model IDs and reasoning capabilities", () => {
        expect(MODELS.map((model) => model.id)).toEqual([
            ...CLAUDE_MAIN_MODELS,
            ...GEMINI_MAIN_MODELS,
            ...OPENAI_MAIN_MODELS,
            ...MISTRAL_MAIN_MODELS,
        ]);
        expect(LEGACY_MODEL_IDS).toEqual(BACKEND_LEGACY_MODEL_IDS);
        for (const { id } of MODELS) {
            expect(reasoningLevelsForModel(id)).toEqual(backendReasoningLevels(id));
        }
        // Bedrock ids reach Claude through several prefixes; the picker and
        // the backend must agree that Opus 5.5 cannot run without thinking.
        for (const id of [
            "bedrock/anthropic.claude-opus-5-5",
            "bedrock/us.anthropic.claude-opus-5-5",
            "bedrock/us-gov.anthropic.claude-opus-5-5",
            "bedrock/arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5",
            "bedrock/us.anthropic.claude-sonnet-5-5",
            "bedrock/meta.llama4-maverick-17b-instruct-v1:0",
        ]) {
            expect(reasoningLevelsForModel(id)).toEqual(backendReasoningLevels(id));
        }
        expect(
            reasoningLevelsForModel(
                "bedrock/arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5",
            ),
        ).not.toContain("none");
    });
    it("offers exactly the web app's static models (id, label, group)", () => {
        const webModels = MODELS.map(({ id, label, group }) => ({
            id,
            label,
            group,
        }));
        const addinModels = STATIC_MODELS.map(({ id, label, group }) => ({
            id,
            label,
            group,
        }));
        expect(addinModels).toEqual(webModels);
    });

    it("shares the web app's default model", () => {
        expect(ADDIN_DEFAULT_MODEL_ID).toBe(DEFAULT_MODEL_ID);
    });

    it("maps the same retired ids to the same current ids", () => {
        // A rename is only survivable if BOTH clients map the old id. The web
        // app maps it and the add-in did not, so the same localStorage value
        // (chat/profile selections are shared by API contract) resolved differently
        // depending on which client read it.
        expect(ADDIN_LEGACY_MODEL_IDS).toEqual(LEGACY_MODEL_IDS);
        for (const id of [
            ...Object.keys(LEGACY_MODEL_IDS),
            ...Object.values(LEGACY_MODEL_IDS),
            ...MODELS.map((model) => model.id),
            "openrouter/openai/gpt-5.4",
            "opencode-go/glm-5",
            "ollama/llama3:8b",
            "not-a-model",
        ]) {
            expect.soft(addinCanonicalModelId(id), id).toBe(
                canonicalModelId(id),
            );
        }
    });

    it("accepts exactly the same set of stored selection ids", () => {
        const probes = [
            ...MODELS.map((model) => model.id),
            ...Object.keys(LEGACY_MODEL_IDS),
            ...Object.values(LEGACY_MODEL_IDS),
            "claude-haiku-4-5",
            "openrouter/openai/gpt-5.4",
            "openrouter/openrouter/auto",
            "vercel/openai/gpt-5.4",
            "opencode-go/glm-5",
            "ollama/llama3:8b",
            "openrouter",
            "opencode-go",
            "",
            "gpt-5.4-turbo-imaginary",
        ];
        for (const id of probes) {
            expect
                .soft(addinIsAllowedModelId(id), id)
                .toBe(webIsAllowedModelId(id));
        }
    });

    it("renders identical display names for every shared id", () => {
        const sharedIds = [
            ...MODELS.map((model) => model.id),
            "openrouter/anthropic/claude-sonnet-4.5",
            "openrouter/meta-llama/llama-3-3-70b-instruct",
            "openrouter/openrouter/auto",
            "vercel/openai/gpt-5.4",
            "vercel/vercel/v0-1.5-md",
            "opencode-go/glm-5",
            "opencode-go/qwen3.8-max",
            "ollama/llama3:8b",
        ];
        for (const id of sharedIds) {
            expect(addinModelDisplayName(id)).toBe(modelDisplayName(id));
        }
    });

    it("builds the same composer model id from a stored selection", () => {
        // A stored selection is the router's raw catalog id. Both clients must
        // send `router/<catalog-id>` verbatim — including ids that begin with
        // the router's own slug, where a defensive inner strip would make the
        // add-in send a different model than the web app for the same row.
        const stored = [
            "anthropic/claude-sonnet-4.5",
            "openrouter/auto",
            "vercel/v0-1.5-md",
        ];
        expect(
            addinOpenRouterModelOptions(stored).map((option) => option.id),
        ).toEqual(openRouterModelOptions(stored).map((option) => option.id));
        expect(
            addinVercelModelOptions(stored).map((option) => option.id),
        ).toEqual(vercelModelOptions(stored).map((option) => option.id));
        expect(
            addinOpenCodeGoModelOptions(["glm-5", "opencode-go/kimi-k3"]).map(
                (option) => option.id,
            ),
        ).toEqual(
            openCodeGoModelOptions(["glm-5", "opencode-go/kimi-k3"]).map(
                (option) => option.id,
            ),
        );
        expect(
            addinOpenRouterModelOptions(["openrouter/auto"])[0]?.id,
        ).toBe("openrouter/openrouter/auto");
    });

    it("gates every shared model on the same provider key in both clients", () => {
        const providers = [
            "claude",
            "gemini",
            "openai",
            "mistral",
            "openrouter",
            "vercel",
            "opencode-go",
        ] as const;
        const sharedIds = [
            ...MODELS.map((model) => model.id),
            "openrouter/openai/gpt-5.4",
            "vercel/openai/gpt-5.4",
            "opencode-go/glm-5",
        ];
        for (const configured of providers) {
            const addinStatus = {
                claude: false,
                gemini: false,
                openai: false,
                mistral: false,
                openrouter: false,
                vercel: false,
                "opencode-go": false,
                courtlistener: false,
                [configured]: true,
            } as unknown as ApiKeyStatus;
            const webState = Object.fromEntries(
                [...providers, "courtlistener"].map((provider) => [
                    provider,
                    {
                        configured: provider === configured,
                        source: provider === configured ? "user" : null,
                    },
                ]),
            ) as ApiKeyState;
            for (const id of sharedIds) {
                expect
                    .soft(
                        addinIsModelAvailable(id, addinStatus),
                        `${id} with only ${configured} configured`,
                    )
                    .toBe(webIsModelAvailable(id, webState));
            }
        }
    });
});

describe("router parity across the web app, the add-in and the backend", () => {
    const selections = {
        openrouter: ["anthropic/claude-sonnet-4.5", "openrouter/auto"],
        vercel: ["openai/gpt-5.4"],
        "opencode-go": ["glm-5"],
        bedrock: ["us.anthropic.claude-opus-5-5", "meta.llama4-v1:0"],
        azure: ["gpt-6.1-sol"],
        "azure-foundry": ["claude-opus-5-5", "anthropic:prod-sonnet"],
        vertex: [
            "gemini-3.1-pro-preview",
            "claude-opus-5-5@20260101",
            "meta/llama-4-maverick-maas",
            "openai:mistral-large-2411",
        ],
        xai: ["grok-4.3"],
        custom: ["deepseek/deepseek-v4", "my-model"],
    };

    it("lists the same routers, in the same order, with the same profile fields", () => {
        expect([...ADDIN_ROUTER_SLUGS]).toEqual([...WEB_ROUTER_SLUGS]);
        expect(backendRouterSlugs()).toEqual([...WEB_ROUTER_SLUGS]);
        expect(ADDIN_ROUTER_PROFILE_FIELDS).toEqual(WEB_ROUTER_PROFILE_FIELDS);
    });

    it("builds identical picker options for every router", () => {
        expect(addinRouterModelOptions(selections)).toEqual(
            webRouterModelOptions(selections),
        );
    });

    it("accepts and gates every router's models in the add-in", () => {
        const status = {
            claude: false,
            gemini: false,
            openai: false,
            mistral: false,
            openrouter: false,
            vercel: false,
            "opencode-go": false,
            courtlistener: false,
        } as ApiKeyStatus;
        for (const slug of WEB_ROUTER_SLUGS) {
            const id = `${slug}/some-model`;
            expect(addinIsAllowedModelId(id)).toBe(true);
            expect(addinIsModelAvailable(id, status)).toBe(false);
            expect(addinIsModelAvailable(id, { ...status, [slug]: true })).toBe(
                true,
            );
        }
    });

    it("agrees on reasoning levels for ids that state their protocol", () => {
        for (const id of [
            "azure-foundry/anthropic:claude-opus-5-5",
            "vertex/anthropic:claude-opus-5-5@20260101",
            "vertex/openai:mistral-large-2411",
        ]) {
            expect(reasoningLevelsForModel(id)).toEqual(
                backendReasoningLevels(id),
            );
        }
    });
});

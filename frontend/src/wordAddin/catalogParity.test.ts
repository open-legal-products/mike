/**
 * The Word add-in builds its model picker from the same catalog as the web
 * app: frontend/src/shared/lib/modelCatalog.ts, which the add-in compiles
 * through the "@mike/model-catalog" alias (the add-in's typecheck and build
 * fail if that alias breaks). These tests keep a hand copy from creeping
 * back in, check the add-in's thin adapter for its own key-status shape
 * against the web app's, and keep the shared catalog in line with the
 * backend.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    MODELS,
    ROUTER_SLUGS,
    LEGACY_MODEL_IDS,
    noModelsReason,
    type RouterSelections,
} from "../shared/lib/modelCatalog";
import {
    isModelAvailable as addinIsModelAvailable,
    noModelsReason as addinNoModelsReason,
} from "../../../word-addin/src/taskpane/lib/modelCatalog";
import type { ApiKeyStatus } from "../../../word-addin/src/taskpane/types";
import { isModelAvailable as webIsModelAvailable } from "../app/lib/modelAvailability";
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

const ADDIN_ROOT = path.resolve(__dirname, "../../../word-addin");

function addinSources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) return addinSources(file);
        return /\.tsx?$/.test(name) ? [file] : [];
    });
}

/** One id per model-id prefix PR #608 added. */
const BYOK_PROBES = [
    "bedrock/us.anthropic.claude-sonnet-5-5",
    "azure/gpt-6-astra-prod",
    "azure-foundry/mistral-large-4",
    "vertex/claude-opus-5-5@20260101",
    "xai/grok-5",
    "custom/qwen3-235b-a22b",
];

describe("word add-in model catalog", () => {
    it("keeps no hand copy of the catalog in the add-in", () => {
        // The declarations that used to be mirrored by hand. Any of them
        // reappearing under word-addin/src is a second catalog to drift.
        const copied =
            /export (?:const|function) (?:ROUTER_SLUGS|STATIC_MODELS|MODELS|LEGACY_MODEL_IDS|modelDisplayName|underlyingProviderGroup|bedrockCatalogModel|vertexCatalogModel|\w+ModelOptions|NO_MODELS_MESSAGES)\b/;
        const offenders = addinSources(path.join(ADDIN_ROOT, "src")).filter(
            (file) => copied.test(readFileSync(file, "utf8")),
        );
        expect(offenders).toEqual([]);
    });

    it("keeps the shared catalog aligned with backend model IDs and reasoning capabilities", () => {
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
    it("explains an empty picker with the same reason in both clients", () => {
        const scenarios: Array<{
            name: string;
            addin: Partial<ApiKeyStatus>;
            web: Partial<ApiKeyState>;
            routerModels: Partial<RouterSelections>;
        }> = [
            { name: "no keys", addin: {}, web: {}, routerModels: {} },
            {
                name: "bedrock connected, no selections",
                addin: { bedrock: true, enabled: { bedrock: true } },
                web: { bedrock: { configured: true, enabled: true, source: "user" } },
                routerModels: { bedrock: [] },
            },
            {
                name: "every key switched off",
                addin: { claude: false, xai: false, enabled: { claude: false, xai: false } },
                web: {
                    claude: { configured: false, enabled: false, source: "user" },
                    xai: { configured: false, enabled: false, source: "user" },
                },
                routerModels: { xai: [] },
            },
        ];
        for (const scenario of scenarios) {
            const addinStatus = { ...scenario.addin } as ApiKeyStatus;
            const webState = { ...scenario.web } as ApiKeyState;
            expect
                .soft(
                    addinNoModelsReason(addinStatus, scenario.routerModels),
                    scenario.name,
                )
                .toBe(noModelsReason(webState, scenario.routerModels));
        }
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
            "bedrock",
            "azure",
            "azure-foundry",
            "vertex",
            "xai",
            "custom",
        ] as const;
        const sharedIds = [
            ...MODELS.map((model) => model.id),
            "openrouter/openai/gpt-5.4",
            "vercel/openai/gpt-5.4",
            "opencode-go/glm-5",
            ...BYOK_PROBES,
        ];
        for (const configured of providers) {
            const addinStatus = {
                ...Object.fromEntries(
                    [...providers, "courtlistener"].map((provider) => [
                        provider,
                        false,
                    ]),
                ),
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

    it("hides a provider that is switched off in both clients", () => {
        // GET /user/api-keys keeps a switched-off key ({ enabled: false });
        // neither picker may offer its models.
        for (const id of ["claude-opus-5-5", ...BYOK_PROBES]) {
            const provider = id.includes("/") ? id.split("/", 1)[0]! : "claude";
            const addinStatus = {
                [provider]: true,
                enabled: { [provider]: false },
            } as unknown as ApiKeyStatus;
            const webState = {
                [provider]: { configured: true, enabled: false, source: "user" },
            } as unknown as ApiKeyState;
            expect.soft(addinIsModelAvailable(id, addinStatus), id).toBe(false);
            expect.soft(webIsModelAvailable(id, webState), id).toBe(false);
        }
    });
});

// Parse the literal list without importing the backend database module.
describe("router parity with the backend", () => {
    it("keeps the router order aligned", () => {
        const source = readFileSync(path.resolve(__dirname, "../../../backend/src/lib/routerModels.ts"), "utf8");
        const declaration = /export const ROUTER_SLUGS[^=]*=\s*\[([^\]]*)\]/.exec(source);
        if (!declaration) throw new Error("backend ROUTER_SLUGS not found");
        expect([...declaration[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)).toEqual([...ROUTER_SLUGS]);
    });

    it("agrees on reasoning levels for ids that state their protocol", () => {
        for (const id of [
            "azure-foundry/anthropic:claude-opus-5-5",
            "vertex/anthropic:claude-opus-5-5@20260101",
            "vertex/openai:mistral-large-2411",
        ]) {
            expect(reasoningLevelsForModel(id)).toEqual(backendReasoningLevels(id));
        }
    });
});

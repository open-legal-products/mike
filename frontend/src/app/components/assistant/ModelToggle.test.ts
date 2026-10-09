import { describe, expect, it } from "vitest";
import {
    azureModelOptions,
    bedrockCatalogModel,
    bedrockModelOptions,
    azureFoundryModelOptions,
    customModelOptions,
    vertexCatalogModel,
    vertexModelOptions,
    xaiModelOptions,
    modelDisplayName,
    openRouterModelOptions,
    vercelModelOptions,
} from "./ModelToggle";

describe("model display names", () => {
    it("formats provider model identifiers as readable names", () => {
        expect(modelDisplayName("anthropic/claude-sonnet-4-6")).toBe(
            "Claude Sonnet 4.6",
        );
        expect(
            modelDisplayName("openrouter/meta-llama/llama-3-3-70b-instruct"),
        ).toBe("Llama 3.3 70B Instruct");
    });

    it("uses the readable name for OpenRouter toggle options", () => {
        expect(openRouterModelOptions(["openai/gpt-4o-mini"])[0]).toMatchObject(
            {
                id: "openrouter/openai/gpt-4o-mini",
                label: "GPT 4o Mini",
            },
        );
    });

    it("uses the readable name for Vercel AI Gateway toggle options", () => {
        expect(vercelModelOptions(["openai/gpt-5.4"])[0]).toMatchObject({
            id: "vercel/openai/gpt-5.4",
            label: "GPT 5.4",
            group: "OpenAI",
            source: "Vercel",
        });
    });
});

describe("cloud platform options", () => {
    it("reads Bedrock ids as vendor/model without AWS-only decoration", () => {
        expect(bedrockCatalogModel("us.anthropic.claude-opus-5-5")).toBe(
            "anthropic/claude-opus-5-5",
        );
        expect(
            bedrockCatalogModel("anthropic.claude-sonnet-4-5-20250929-v1:0"),
        ).toBe("anthropic/claude-sonnet-4-5");
        expect(
            bedrockCatalogModel(
                "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
            ),
        ).toBe("anthropic/claude-opus-5-5");
        expect(bedrockCatalogModel("meta.llama4-maverick-17b-instruct-v1:0")).toBe(
            "meta/llama4-maverick-17b-instruct",
        );
        // An id that is not vendor.model is shown as typed.
        expect(bedrockCatalogModel("my-application-profile")).toBe(
            "my-application-profile",
        );
    });

    it("groups Bedrock models by maker and keeps the id verbatim", () => {
        expect(bedrockModelOptions(["us.anthropic.claude-opus-5-5"])[0]).toEqual({
            id: "bedrock/us.anthropic.claude-opus-5-5",
            label: "Claude Opus 5.5",
            group: "Anthropic",
            source: "Bedrock",
        });
    });

    it("reads Vertex ids without the version pin or partner suffix", () => {
        expect(vertexCatalogModel("claude-opus-5-5@20260101")).toBe(
            "claude-opus-5-5",
        );
        expect(vertexCatalogModel("meta/llama-4-maverick-maas")).toBe(
            "meta/llama-4-maverick",
        );
        expect(vertexModelOptions(["claude-opus-5-5@20260101"])[0]).toEqual({
            id: "vertex/claude-opus-5-5@20260101",
            label: "Claude Opus 5.5",
            group: "Anthropic",
            source: "Vertex",
        });
        expect(vertexModelOptions(["gemini-3.1-pro-preview"])[0]).toMatchObject({
            id: "vertex/gemini-3.1-pro-preview",
            group: "Google",
        });
    });

    it("labels Foundry, xAI and custom endpoint models by their source", () => {
        expect(azureFoundryModelOptions(["claude-opus-5-5"])[0]).toEqual({
            id: "azure-foundry/claude-opus-5-5",
            label: "Claude Opus 5.5",
            group: "Anthropic",
            source: "Foundry",
        });
        expect(xaiModelOptions(["grok-4.3"])[0]).toEqual({
            id: "xai/grok-4.3",
            label: "Grok 4.3",
            group: "xAI",
            source: "xAI",
        });
        expect(customModelOptions(["deepseek/deepseek-v4"])[0]).toEqual({
            id: "custom/deepseek/deepseek-v4",
            label: "Deepseek V4",
            group: "DeepSeek",
            source: "Custom",
        });
    });

    it("keeps an explicit protocol in the id but out of the label", () => {
        expect(azureFoundryModelOptions(["anthropic:prod-sonnet"])[0]).toMatchObject({
            id: "azure-foundry/anthropic:prod-sonnet",
            label: "Prod Sonnet",
        });
        expect(vertexModelOptions(["openai:mistral-large-2411"])[0]).toMatchObject({
            id: "vertex/openai:mistral-large-2411",
            label: "Mistral Large 2411",
            group: "Mistral AI",
        });
    });

    it("labels Azure deployments by name", () => {
        expect(azureModelOptions(["gpt-6.1-sol"])[0]).toEqual({
            id: "azure/gpt-6.1-sol",
            label: "GPT 6.1 Sol",
            group: "OpenAI",
            source: "Azure",
        });
    });
});

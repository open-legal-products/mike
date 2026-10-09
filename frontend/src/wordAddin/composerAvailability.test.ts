/**
 * Word add-in composer availability semantics, exercised from the frontend
 * test runner (the add-in package has no unit-test runner of its own).
 */
import { describe, expect, it, vi } from "vitest";
import {
    isModelAvailable,
    unavailableModelMessage,
} from "../../../word-addin/src/taskpane/lib/modelCatalog";
import { loadWithRetry } from "../../../word-addin/src/taskpane/lib/composerPreflight";
import type { ApiKeyStatus } from "../../../word-addin/src/taskpane/types";

const NO_KEYS: ApiKeyStatus = {
    claude: false,
    gemini: false,
    openai: false,
    openrouter: false,
    vercel: false,
    "opencode-go": false,
    courtlistener: false,
} as ApiKeyStatus;

describe("isModelAvailable fail-open", () => {
    it("allows sends while key status is unknown (null)", () => {
        // A flaky WKWebView preflight must not brick the composer: the
        // backend still rejects models it cannot serve.
        expect(isModelAvailable("gemini-3.8-flash", null)).toBe(true);
        expect(isModelAvailable("claude-fable-5-1", null)).toBe(true);
        expect(isModelAvailable("openrouter/openai/gpt-5.4", null)).toBe(true);
        expect(isModelAvailable("vercel/openai/gpt-5.4", null)).toBe(true);
        expect(isModelAvailable("opencode-go/glm-5", null)).toBe(true);
    });

    it("still gates on a LOADED status", () => {
        expect(isModelAvailable("gemini-3.8-flash", NO_KEYS)).toBe(false);
        expect(isModelAvailable("openrouter/openai/gpt-5.4", NO_KEYS)).toBe(
            false,
        );
        expect(isModelAvailable("opencode-go/glm-5", NO_KEYS)).toBe(false);
        expect(
            isModelAvailable("gemini-3.8-flash", {
                ...NO_KEYS,
                gemini: true,
            }),
        ).toBe(true);
        expect(
            isModelAvailable("opencode-go/glm-5", {
                ...NO_KEYS,
                "opencode-go": true,
            }),
        ).toBe(true);
    });
});

describe("unavailableModelMessage", () => {
    it("names the PR #608 provider whose key is missing", () => {
        expect(
            unavailableModelMessage("bedrock/us.anthropic.claude-opus-5-5", NO_KEYS),
        ).toBe("Add an Amazon Bedrock API key before using this model.");
        expect(unavailableModelMessage("gemini-3.8-flash", NO_KEYS)).toBe(
            "Add a Google API key before using this model.",
        );
    });

    it("asks to turn a switched-off provider back on instead of adding a key", () => {
        expect(
            unavailableModelMessage("xai/grok-5", {
                ...NO_KEYS,
                xai: false,
                enabled: { xai: false },
            }),
        ).toBe(
            "xAI is turned off. Turn it back on in Bring Your Own Keys before using this model.",
        );
    });
});

describe("loadWithRetry", () => {
    it("returns the value from a successful retry", async () => {
        const load = vi
            .fn()
            .mockRejectedValueOnce(new Error("transient"))
            .mockResolvedValueOnce("loaded");

        await expect(
            loadWithRetry(load, { delayMs: 0 }),
        ).resolves.toBe("loaded");
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("resolves null and reports the error after the final failure", async () => {
        const boom = new Error("still down");
        const load = vi.fn().mockRejectedValue(boom);
        const onFinalFailure = vi.fn();

        await expect(
            loadWithRetry(load, { delayMs: 0, onFinalFailure }),
        ).resolves.toBeNull();
        expect(load).toHaveBeenCalledTimes(2);
        expect(onFinalFailure).toHaveBeenCalledWith(boom);
    });

    it("does not retry after a success", async () => {
        const load = vi.fn().mockResolvedValue("ok");

        await expect(loadWithRetry(load, { delayMs: 0 })).resolves.toBe("ok");
        expect(load).toHaveBeenCalledTimes(1);
    });
});

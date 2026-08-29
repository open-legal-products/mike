import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSelectedModel, useSelectedReasoning } from "./useSelectedModel";
import { canonicalModelId } from "../components/assistant/ModelToggle";
import type { ApiKeyState } from "../lib/mikeApi";

const keys: ApiKeyState = {
    claude: { configured: true, source: "user" },
    gemini: { configured: false, source: null },
    openai: { configured: true, source: "user" },
    openrouter: { configured: true, source: "user" },
    orcarouter: { configured: false, source: null },
    vercel: { configured: false, source: null },
    "opencode-go": { configured: false, source: null },
    courtlistener: { configured: false, source: null },
};

const routerSelections = {
    openRouterModels: ["openai/gpt-5.4"],
    orcaRouterModels: [],
    vercelModels: [],
    openCodeGoModels: [],
};

describe("useSelectedModel", () => {
    it("has no invented default when neither saved source is usable", () => {
        const { result } = renderHook(() => useSelectedModel());
        expect(result.current[0]).toBe("");
    });

    it("uses the saved chat model before the shared last-selected model", () => {
        const { result } = renderHook(() =>
            useSelectedModel({
                chatModel: "claude-fable-5",
                lastSelectedModel: "gpt-5.6-luna",
                apiKeys: keys,
            }),
        );
        expect(result.current[0]).toBe("claude-fable-5");
    });

    it("falls back to last-selected when the chat model has no current key", () => {
        const { result } = renderHook(() =>
            useSelectedModel({
                chatModel: "gemini-3.7-flash",
                lastSelectedModel: "gpt-5.6-luna",
                apiKeys: keys,
            }),
        );
        expect(result.current[0]).toBe("gpt-5.6-luna");
    });

    it("keeps an explicit selection in component state only", () => {
        const { result } = renderHook(() => useSelectedModel());

        act(() => result.current[1]("claude-fable-5"));

        expect(result.current[0]).toBe("claude-fable-5");
    });

    it("uses a chat router model while it remains in the saved list", () => {
        const { result } = renderHook(() =>
            useSelectedModel({
                chatModel: "openrouter/openai/gpt-5.4",
                lastSelectedModel: "gpt-5.6-luna",
                routerSelections,
                apiKeys: keys,
            }),
        );
        expect(result.current[0]).toBe("openrouter/openai/gpt-5.4");
    });

    it("falls back when the chat router model is no longer saved", () => {
        const { result } = renderHook(() =>
            useSelectedModel({
                chatModel: "openrouter/pricy/frontier",
                lastSelectedModel: "gpt-5.6-luna",
                routerSelections,
                apiKeys: keys,
            }),
        );
        expect(result.current[0]).toBe("gpt-5.6-luna");
    });

    it("does not flash the profile model while an existing chat loads", () => {
        const { result, rerender } = renderHook(
            ({ chatModel }: { chatModel: string | null | undefined }) =>
                useSelectedModel({
                    selectionKey: "chat-1",
                    chatModel,
                    lastSelectedModel: "gpt-5.6-luna",
                    apiKeys: keys,
                }),
            {
                initialProps: {
                    chatModel: undefined as string | null | undefined,
                },
            },
        );

        expect(result.current[0]).toBe("");
        rerender({ chatModel: "claude-fable-5" });
        expect(result.current[0]).toBe("claude-fable-5");
    });
});

describe("useSelectedReasoning", () => {
    it("loads the chat level before the profile fallback", () => {
        const { result } = renderHook(() =>
            useSelectedReasoning({
                selectionKey: "chat-1",
                chatReasoningLevel: "low",
                lastSelectedReasoningLevel: "xhigh",
            }),
        );
        expect(result.current[0]).toBe("low");
    });

    it("defaults a new user to high", () => {
        const { result } = renderHook(() => useSelectedReasoning({}));
        expect(result.current[0]).toBe("high");
    });

    it("uses the profile reasoning level on surfaces without chat settings", () => {
        const { result } = renderHook(() =>
            useSelectedReasoning({ lastSelectedReasoningLevel: "low" }),
        );
        expect(result.current[0]).toBe("low");
    });
});

describe("canonicalModelId", () => {
    it("maps only known legacy ids", () => {
        expect(canonicalModelId("gemini-3.1-flash-lite-preview")).toBe(
            "gemini-3.5-flash-lite",
        );
        expect(canonicalModelId("gpt-5.4-lite")).toBe("gpt-5.4-mini");
        expect(canonicalModelId("claude-fable-5")).toBe("claude-fable-5");
    });
});

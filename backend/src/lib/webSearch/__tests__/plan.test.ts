import { describe, expect, it } from "vitest";

import { webSearchPlanFor } from "../plan";
import { DEFAULT_WEB_SEARCH_SETTINGS, type WebSearchSettings } from "../settings";

const settings = (overrides: Partial<WebSearchSettings>): WebSearchSettings => ({
    ...DEFAULT_WEB_SEARCH_SETTINGS,
    enabled: true,
    ...overrides,
});

describe("webSearchPlanFor", () => {
    it.each([
        ["claude-sonnet-5-5", {}, {}, "provider"],
        ["gpt-6.1-sol", { openai: "brave" }, { brave: "k" }, "brave"],
        ["gpt-6.1-sol", { openai: "brave" }, {}, null],
        ["claude-sonnet-5-5", { claude: "off" }, { brave: "k" }, null],
        ["gemini-3.8-flash", { other: "brave" }, { brave: "k" }, "brave"],
        ["gemini-3.8-flash", {}, { brave: "k" }, null],
        ["claude-sonnet-5-5", { enabled: false }, {}, null],
    ] as const)("%s with %o and keys %o", (model, overrides, keys, expected) => {
        expect(webSearchPlanFor(settings(overrides), model, keys)).toBe(expected);
    });
});

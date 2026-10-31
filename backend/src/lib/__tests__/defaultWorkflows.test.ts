import { afterEach, describe, expect, it } from "vitest";
import {
    defaultWorkflowByKey,
    loadDefaultWorkflows,
    resetDefaultWorkflowsCache,
} from "../defaultWorkflows";

function withEnv(value: string | undefined) {
    if (value === undefined) delete process.env.MIKE_DEFAULT_WORKFLOWS_JSON;
    else process.env.MIKE_DEFAULT_WORKFLOWS_JSON = value;
    resetDefaultWorkflowsCache();
}

afterEach(() => withEnv(undefined));

describe("default workflow list", () => {
    it("is Mike's five defaults when unset", () => {
        withEnv(undefined);
        expect(loadDefaultWorkflows()).toEqual([
            { key: "proofread", quickAction: true, wordQuickAction: true },
            { key: "compare-documents", quickAction: true, wordQuickAction: false },
            { key: "extract-key-terms", quickAction: true, wordQuickAction: true },
            { key: "draft-from-template", quickAction: true, wordQuickAction: true },
            {
                key: "commercial-agreement-tabular-review",
                quickAction: false,
                wordQuickAction: false,
            },
        ]);
    });

    it("is Mike's five defaults when blank", () => {
        withEnv("   ");
        expect(loadDefaultWorkflows().map((w) => w.key)).toHaveLength(5);
    });

    it("may be empty", () => {
        withEnv("[]");
        expect(loadDefaultWorkflows()).toEqual([]);
        expect(defaultWorkflowByKey().size).toBe(0);
    });

    it("reads the configured list in order, defaulting missing flags to false", () => {
        withEnv('[{"key":"proofread","quickAction":true},{"key":"research-memo"}]');
        expect(loadDefaultWorkflows()).toEqual([
            { key: "proofread", quickAction: true, wordQuickAction: false },
            { key: "research-memo", quickAction: false, wordQuickAction: false },
        ]);
        expect(defaultWorkflowByKey().get("research-memo")).toEqual({
            key: "research-memo",
            quickAction: false,
            wordQuickAction: false,
            sortOrder: 1,
        });
        expect(defaultWorkflowByKey().get("proofread")?.sortOrder).toBe(0);
    });

    it.each([
        ["invalid JSON", "not json"],
        ["an object", "{}"],
        ["an entry without a key", '[{"quickAction":true}]'],
        ["a malformed key", '[{"key":"Bad Key"}]'],
        ["a duplicated key", '[{"key":"proofread"},{"key":"proofread"}]'],
        ["a non-boolean flag", '[{"key":"proofread","quickAction":"yes"}]'],
    ])("rejects %s loudly", (_label, value) => {
        withEnv(value);
        expect(() => loadDefaultWorkflows()).toThrow("MIKE_DEFAULT_WORKFLOWS_JSON");
    });
});

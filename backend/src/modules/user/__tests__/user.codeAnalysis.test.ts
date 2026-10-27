import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/sandbox", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/sandbox")>()),
    sandboxCapabilities: vi.fn(async () => ({ python: true, render: true })),
}));

import {
    loadCodeAnalysisSetting,
    saveCodeAnalysisSettings,
    validateCodeAnalysisPayload,
} from "../user.codeAnalysis";

function db(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq", "update"]) chain[method] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => result);
    return chain as never;
}

const missingColumn = { code: "42703", message: 'column user_profiles.code_analysis does not exist' };

describe("code analysis setting", () => {
    it("is on by default and reads the stored choice", async () => {
        await expect(loadCodeAnalysisSetting(db({ data: null, error: null }), "u")).resolves.toBe(true);
        await expect(loadCodeAnalysisSetting(db({ data: { code_analysis: false }, error: null }), "u")).resolves.toBe(false);
    });

    it("reads as on before the migration, and refuses to save until it has run", async () => {
        await expect(loadCodeAnalysisSetting(db({ data: null, error: missingColumn }), "u")).resolves.toBe(true);
        await expect(saveCodeAnalysisSettings(db({ data: null, error: missingColumn }), "u", false)).resolves.toMatchObject({
            ok: false,
            kind: "unavailable",
            code: "schema_out_of_date",
        });
        await expect(saveCodeAnalysisSettings(db({ data: { code_analysis: false }, error: null }), "u", false)).resolves.toEqual({
            ok: true,
            data: { enabled: false, available: true },
        });
    });

    it("accepts only a boolean enabled", () => {
        expect(validateCodeAnalysisPayload({ enabled: false })).toEqual({ ok: true, enabled: false });
        expect(validateCodeAnalysisPayload({ enabled: "no" })).toMatchObject({ ok: false });
        expect(validateCodeAnalysisPayload([])).toMatchObject({ ok: false });
    });
});

import { describe, expect, it, vi } from "vitest";
import {
    CUSTOM_INSTRUCTIONS_MAX_LENGTH,
    getCustomInstructions,
    loadCustomInstructions,
    saveCustomInstructions,
    validateCustomInstructionsPayload,
} from "../user.customInstructions";

function db(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq", "update"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => result);
    return chain as never;
}

const missingColumn = {
    code: "42703",
    message: 'column user_profiles.custom_instructions does not exist',
};

describe("validateCustomInstructionsPayload", () => {
    it("normalizes line endings and trailing whitespace", () => {
        expect(
            validateCustomInstructionsPayload({ content: "a\r\nb\r\n\n  " }),
        ).toEqual({ ok: true, content: "a\nb" });
    });

    it("accepts an empty string to clear the instructions", () => {
        expect(validateCustomInstructionsPayload({ content: "" })).toEqual({
            ok: true,
            content: "",
        });
    });

    it("rejects non-string content and non-object bodies", () => {
        expect(validateCustomInstructionsPayload({ content: 1 }).ok).toBe(
            false,
        );
        expect(validateCustomInstructionsPayload([]).ok).toBe(false);
        expect(validateCustomInstructionsPayload(null).ok).toBe(false);
    });

    it("rejects content over the length limit", () => {
        expect(
            validateCustomInstructionsPayload({
                content: "x".repeat(CUSTOM_INSTRUCTIONS_MAX_LENGTH),
            }).ok,
        ).toBe(true);
        expect(
            validateCustomInstructionsPayload({
                content: "x".repeat(CUSTOM_INSTRUCTIONS_MAX_LENGTH + 1),
            }).ok,
        ).toBe(false);
    });
});

describe("custom instructions storage", () => {
    it("reads the stored instructions", async () => {
        await expect(
            getCustomInstructions(
                db({ data: { custom_instructions: "Be brief." }, error: null }),
                "user-1",
            ),
        ).resolves.toEqual({ ok: true, data: { content: "Be brief." } });
    });

    it("reads as empty before the migration is applied", async () => {
        await expect(
            loadCustomInstructions(
                db({ data: null, error: missingColumn }),
                "user-1",
            ),
        ).resolves.toBe("");
    });

    it("reports other read errors as internal failures", async () => {
        const result = await getCustomInstructions(
            db({ data: null, error: { code: "XX000", message: "boom" } }),
            "user-1",
        );
        expect(result).toMatchObject({ ok: false, kind: "error" });
    });

    it("returns the saved instructions", async () => {
        await expect(
            saveCustomInstructions(
                db({ data: { custom_instructions: "Be brief." }, error: null }),
                "user-1",
                "Be brief.",
            ),
        ).resolves.toEqual({ ok: true, data: { content: "Be brief." } });
    });

    it("maps a missing profile and a missing column to typed failures", async () => {
        await expect(
            saveCustomInstructions(db({ data: null, error: null }), "u", "x"),
        ).resolves.toMatchObject({ ok: false, kind: "not_found" });
        await expect(
            saveCustomInstructions(
                db({ data: null, error: missingColumn }),
                "u",
                "x",
            ),
        ).resolves.toMatchObject({ ok: false, kind: "unavailable" });
    });
});

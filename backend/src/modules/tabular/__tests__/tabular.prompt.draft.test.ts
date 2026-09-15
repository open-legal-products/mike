// Unit tests for `draftColumnPrompt` — the LLM call behind POST
// /tabular-review/prompt. The branching worth pinning is the failure policy:
// a missing default model is the user's to fix (409), while everything the
// provider does wrong is a 502, including a reply that parses but carries no
// prompt.

import { describe, it, expect, vi, beforeEach } from "vitest";

const completeText = vi.hoisted(() => vi.fn());
// Partial: this module reaches the user facade for model settings, and that
// facade's graph (account deletion → memory curator) reads other `lib/llm`
// exports at import time. A total mock would break the import, not the test.
vi.mock("../../../lib/llm", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/llm")>()),
    completeText,
}));

const getUserModelSettings = vi.hoisted(() => vi.fn());
vi.mock("../../user/user.settings", () => ({ getUserModelSettings }));

import { draftColumnPrompt } from "../tabular.prompt";

// The service takes the request's Supabase client; these tests stub
// getUserModelSettings, so the handle is only passed through.
const DB = {} as never;

const ARGS = {
    userId: "user-1",
    title: "Governing law",
    format: "text",
    documentName: "",
    tags: [] as string[],
};

beforeEach(() => {
    vi.clearAllMocks();
    getUserModelSettings.mockResolvedValue({
        tabular_model: "claude-sonnet-5",
        api_keys: {},
    });
});

describe("draftColumnPrompt", () => {
    it("requires a title before calling the model", async () => {
        const result = await draftColumnPrompt(DB, { ...ARGS, title: "" });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "title is required",
        });
        expect(completeText).not.toHaveBeenCalled();
    });

    it("409s when the user has no default tabular model", async () => {
        getUserModelSettings.mockResolvedValue({
            tabular_model: null,
            api_keys: {},
        });
        const result = await draftColumnPrompt(DB, ARGS);
        expect(result).toMatchObject({ ok: false, kind: "status", status: 409 });
        expect(
            result.ok === false && result.kind === "status" && result.body.code,
        ).toBe("model_required");
    });

    it("unwraps a fenced JSON reply", async () => {
        completeText.mockResolvedValue(
            '```json\n{"prompt":"  Extract the governing law clause.  "}\n```',
        );
        const result = await draftColumnPrompt(DB, ARGS);
        expect(result).toEqual({
            ok: true,
            data: {
                prompt: "Extract the governing law clause.",
                source: "llm",
            },
        });
    });

    it("describes the tag vocabulary to the model", async () => {
        completeText.mockResolvedValue('{"prompt":"p"}');
        await draftColumnPrompt(DB, {
            ...ARGS,
            format: "tag",
            tags: ["Yes", "No"],
            documentName: "NDA",
        });
        const sent = completeText.mock.calls[0][0].user as string;
        expect(sent).toContain("one of these tags: Yes, No");
        expect(sent).toContain("Available tags: Yes, No");
        expect(sent).toContain("Document type/name: NDA");
    });

    it("502s an empty prompt in an otherwise valid reply", async () => {
        completeText.mockResolvedValue('{"prompt":"   "}');
        const result = await draftColumnPrompt(DB, ARGS);
        expect(result).toMatchObject({
            ok: false,
            kind: "status",
            status: 502,
            body: { detail: "LLM returned an empty prompt" },
        });
    });

    it("502s an unparseable reply", async () => {
        completeText.mockResolvedValue("not json at all");
        const result = await draftColumnPrompt(DB, ARGS);
        expect(result).toMatchObject({
            ok: false,
            kind: "status",
            status: 502,
            body: { detail: "Failed to generate prompt from LLM" },
        });
    });

    it("502s a provider failure without leaking its message", async () => {
        completeText.mockRejectedValue(new Error("upstream 401 sk-abc"));
        const result = await draftColumnPrompt(DB, ARGS);
        expect(result).toMatchObject({
            ok: false,
            kind: "status",
            status: 502,
            body: { detail: "Failed to generate prompt from LLM" },
        });
    });
});

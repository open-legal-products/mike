import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../../../lib/webSearch";
import {
    loadWebSearchSettings,
    saveWebSearchSettings,
    validateWebSearchPayload,
} from "../user.webSearch";

/** A client whose profile read and merge function both resolve to `result`. */
function db(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => result);
    chain.rpc = vi.fn(async () => result);
    return chain as never;
}

const rpcOf = (client: unknown) =>
    (client as { rpc: ReturnType<typeof vi.fn> }).rpc;

const missingFunction = {
    code: "PGRST202",
    message:
        "Could not find the function public.merge_user_web_search(p_patch, p_user_id) in the schema cache",
};

describe("validateWebSearchPayload", () => {
    it("accepts a known field and rejects unknown fields and bad values", () => {
        expect(validateWebSearchPayload({ claude: "brave" })).toEqual({
            ok: true,
            update: { claude: "brave" },
        });
        expect(validateWebSearchPayload({ engine: "google" })).toMatchObject({ ok: false });
        expect(validateWebSearchPayload({ enabled: "true" })).toMatchObject({ ok: false });
        expect(validateWebSearchPayload({ other: "provider" })).toMatchObject({ ok: false });
    });
});

describe("web search settings storage", () => {
    it("reads as the default when nothing is stored, else the stored choices", async () => {
        await expect(
            loadWebSearchSettings(db({ data: null, error: null }), "u"),
        ).resolves.toEqual(DEFAULT_WEB_SEARCH_SETTINGS);
        await expect(
            loadWebSearchSettings(
                db({ data: { web_search: { enabled: true, openai: "off" } }, error: null }),
                "u",
            ),
        ).resolves.toEqual({ ...DEFAULT_WEB_SEARCH_SETTINGS, enabled: true, openai: "off" });
    });

    it("merges only the changed setting and returns the full settings", async () => {
        const client = db({ data: { enabled: true }, error: null });

        await expect(saveWebSearchSettings(client, "user-1", { enabled: true })).resolves.toEqual({
            ok: true,
            data: { ...DEFAULT_WEB_SEARCH_SETTINGS, enabled: true },
        });
        expect(rpcOf(client)).toHaveBeenCalledWith("merge_user_web_search", {
            p_user_id: "user-1",
            p_patch: { enabled: true },
        });
    });

    it("reports a save before the migration as unavailable", async () => {
        await expect(
            saveWebSearchSettings(db({ data: null, error: missingFunction }), "u", {
                enabled: true,
            }),
        ).resolves.toMatchObject({ ok: false, kind: "unavailable" });
    });
});

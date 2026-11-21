import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getEffectiveApiKeys, getEffectiveRouterModels, loadCourtListenerConnection } =
    vi.hoisted(() => ({
        getEffectiveApiKeys: vi.fn(),
        getEffectiveRouterModels: vi.fn(),
        loadCourtListenerConnection: vi.fn(),
    }));

vi.mock("../../../lib/providerCredentials/index", () => ({
    getEffectiveApiKeys: (...args: unknown[]) => getEffectiveApiKeys(...args),
    loadCourtListenerConnection: (...args: unknown[]) =>
        loadCourtListenerConnection(...args),
}));

vi.mock("../../../lib/routerModels", async () => ({
    ...(await vi.importActual<typeof import("../../../lib/routerModels")>(
        "../../../lib/routerModels",
    )),
    getEffectiveRouterModels: (...args: unknown[]) =>
        getEffectiveRouterModels(...args),
}));

vi.mock("../../../lib/supabase", () => ({ createServerSupabase: vi.fn() }));

import { getUserModelSettings } from "../user.settings";

function profileDb(row: Record<string, unknown> | null) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => ({ data: row, error: null }));
    chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    return chain as never;
}

const NO_KEYS = {
    claude: null,
    gemini: "env-gemini-key",
    openai: null,
    openrouter: "env-openrouter-key",
    vercel: null,
    courtlistener: null,
};

beforeEach(() => {
    vi.clearAllMocks();
    getEffectiveApiKeys.mockResolvedValue(NO_KEYS);
    loadCourtListenerConnection.mockResolvedValue({ enabled: true, token: null });
    getEffectiveRouterModels.mockResolvedValue({
        openrouter: ["allowed/model"],
        vercel: [],
        "opencode-go": [],
    });
});

describe("getUserModelSettings router-model allowlist", () => {
    it("loads the professional profile used to personalise prompts", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            profileDb({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-5-5",
                display_name: "Ada",
                organisation: "Acme LLP",
                jurisdiction: "Singapore",
                practice_setting: "private_practice",
                professional_title: "Partner",
                practice_areas: ["Litigation"],
                custom_instructions: "Use British spelling.",
                response_style: { verbosity: "concise", tone: "formal" },
                web_search: { enabled: true, other: "brave" },
            }),
        );

        expect(settings.personalisation).toEqual({
            displayName: "Ada",
            organisation: "Acme LLP",
            jurisdiction: "Singapore",
            practiceSetting: "private_practice",
            professionalTitle: "Partner",
            practiceAreas: ["Litigation"],
            customInstructions: "Use British spelling.",
            responseStyle: {
                verbosity: "concise",
                formatting: "balanced",
                tone: "formal",
                language: "auto",
            },
        });
        expect(settings.web_search).toEqual({
            enabled: true,
            claude: "provider",
            openai: "provider",
            other: "brave",
        });
    });

    it("keeps a stored router preference that is in the saved selection", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            profileDb({
                title_model: "openrouter/allowed/model",
                tabular_model: "openrouter/allowed/model",
                memory_curator_model: "openrouter/allowed/model",
            }),
        );

        expect(settings.title_model).toBe("openrouter/allowed/model");
        expect(settings.tabular_model).toBe("openrouter/allowed/model");
        expect(settings.memory_curator_model).toBe("openrouter/allowed/model");
    });

    it("clears stored router preferences outside the saved selection", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            profileDb({
                title_model: "openrouter/pricy/frontier-model",
                tabular_model: "vercel/pricy/frontier-model",
                memory_curator_model: "openrouter/pricy/frontier-model",
            }),
        );

        expect(settings.title_model).toBeNull();
        expect(settings.tabular_model).toBeNull();
        expect(settings.memory_curator_model).toBeNull();
    });

    it("keeps first-party preferences untouched", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            profileDb({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-5-5",
                memory_curator_model: "gpt-6-luna",
            }),
        );

        expect(settings.title_model).toBe("claude-haiku-4-5");
        expect(settings.tabular_model).toBe("claude-sonnet-5-5");
        expect(settings.memory_curator_model).toBe("gpt-6-luna");
    });
});

// A database without the 20260821 onboarding migration rejects the widened
// select outright (42703). The retry with the pre-migration column set must
// preserve the user's saved models and legal-research choice — silently
// resetting them was the severe half of the un-migrated-DB bug.
function retryingProfileDb(
    first: { data: unknown; error: unknown },
    second: { data: unknown; error: unknown },
) {
    const results = [first, second];
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => results.shift() ?? second);
    return chain as never;
}

describe("getUserModelSettings keys", () => {
    it("loads the caller's own keys for personal work", async () => {
        const db = profileDb({});
        await getUserModelSettings("user-1", db);
        expect(getEffectiveApiKeys).toHaveBeenCalledExactlyOnceWith(
            "user-1",
            undefined,
            db,
        );
    });

    it("loads the keys of the organization the work belongs to", async () => {
        const db = profileDb({});
        const settings = await getUserModelSettings("user-1", db, {
            orgId: "org-1",
        });
        expect(getEffectiveApiKeys).toHaveBeenCalledExactlyOnceWith(
            "user-1",
            "org-1",
            db,
        );
        expect(settings.api_keys).toBe(NO_KEYS);
    });

    it("judges saved preferences against the lists that govern those keys", async () => {
        // "org/only" is in the organization's OpenRouter list, not the
        // caller's own: inside the organization it is a usable preference.
        getEffectiveRouterModels.mockImplementation(
            async (_userId: string, orgId: string | null | undefined) => ({
                openrouter: orgId ? ["org/only"] : ["allowed/model"],
                vercel: [],
                "opencode-go": [],
            }),
        );
        const row = { last_selected_chat_model: "openrouter/org/only" };

        const inOrg = await getUserModelSettings("user-1", profileDb(row), {
            orgId: "org-1",
        });
        const personal = await getUserModelSettings("user-1", profileDb(row));

        expect(inOrg.last_selected_chat_model).toBe("openrouter/org/only");
        expect(personal.last_selected_chat_model).toBeNull();
        expect(getEffectiveRouterModels).toHaveBeenCalledWith(
            "user-1",
            "org-1",
            expect.anything(),
        );
    });
});

describe("getUserModelSettings on an un-migrated database", () => {
    it("retries without the memory curator column during rollout", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            retryingProfileDb(
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.memory_curator_model does not exist",
                    },
                },
                {
                    data: {
                        title_model: "claude-haiku-4-5",
                        tabular_model: "claude-sonnet-5-5",
                        last_selected_chat_model: "claude-sonnet-5-5",
                        last_selected_reasoning_level: "high",
                    },
                    error: null,
                },
            ),
        );

        expect(settings.memory_curator_model).toBeNull();
        expect(settings.last_selected_reasoning_level).toBe("high");
        expect(settings.last_selected_chat_model).toBe("claude-sonnet-5-5");
    });

    it("retries without the onboarding columns and keeps saved settings", async () => {
        const settings = await getUserModelSettings(
            "user-1",
            retryingProfileDb(
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.jurisdiction does not exist",
                    },
                },
                {
                    data: {
                        title_model: "claude-haiku-4-5",
                        tabular_model: "claude-sonnet-5-5",
                    },
                    error: null,
                },
            ),
        );

        expect(settings.title_model).toBe("claude-haiku-4-5");
        expect(settings.tabular_model).toBe("claude-sonnet-5-5");
        expect(settings.legal_research_us).toBe(false);
        expect(settings.personalisation).toMatchObject({
            displayName: null,
            practiceAreas: [],
        });
    });

    it("returns empty optional preferences when the retry also fails", async () => {
        getEffectiveApiKeys.mockResolvedValue({
            ...NO_KEYS,
            courtlistener: "user-courtlistener-token",
        });
        const settings = await getUserModelSettings(
            "user-1",
            retryingProfileDb(
                {
                    data: null,
                    error: {
                        code: "42703",
                        message:
                            "column user_profiles.jurisdiction does not exist",
                    },
                },
                {
                    data: null,
                    error: { code: "42703", message: "even older database" },
                },
            ),
        );

        expect(settings.legal_research_us).toBe(true);
        expect(settings.title_model).toBeNull();
        expect(settings.tabular_model).toBeNull();
    });
});

describe("getUserModelSettings CourtListener connector", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });
    const settingsWith = (courtlistener: string | null, enabled = true) => {
        getEffectiveApiKeys.mockResolvedValue({ ...NO_KEYS, courtlistener });
        loadCourtListenerConnection.mockResolvedValue({ enabled, token: null });
        return getUserModelSettings("user-1", profileDb({}));
    };

    it("offers research tools only with a saved token or the bulk index", async () => {
        expect((await settingsWith(null)).legal_research_us).toBe(false);
        expect((await settingsWith("saved-token")).legal_research_us).toBe(true);
        vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "true");
        expect((await settingsWith(null)).legal_research_us).toBe(true);
    });

    it("reads the switch of the workspace the work is in", async () => {
        const db = profileDb({});
        await getUserModelSettings("user-1", db, { orgId: "org-1" });
        expect(loadCourtListenerConnection).toHaveBeenCalledWith(
            { userId: "user-1", orgId: "org-1" },
            db,
        );
        await getUserModelSettings("user-1", db);
        expect(loadCourtListenerConnection).toHaveBeenLastCalledWith(
            { userId: "user-1", orgId: null },
            db,
        );
    });

    it("leaves research off when the switch cannot be read", async () => {
        getEffectiveApiKeys.mockResolvedValue({ ...NO_KEYS, courtlistener: "t" });
        loadCourtListenerConnection.mockRejectedValue(new Error("db down"));
        vi.spyOn(console, "error").mockImplementation(() => {});
        expect(
            (await getUserModelSettings("user-1", profileDb({}))).legal_research_us,
        ).toBe(false);
    });

    it("keeps the user's switch off whatever is configured", async () => {
        vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "true");
        expect((await settingsWith("saved-token", false)).legal_research_us).toBe(
            false,
        );
    });
});

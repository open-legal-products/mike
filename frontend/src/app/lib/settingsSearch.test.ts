import { describe, expect, it } from "vitest";
import {
    SETTINGS_SEARCH_ENTRIES,
    searchSettings,
    type SettingsSearchResult,
} from "./settingsSearch";

function ids(results: SettingsSearchResult[]) {
    return results.map((result) => result.entry.id);
}

function kinds(results: SettingsSearchResult[]) {
    return Object.fromEntries(
        results.map((result) => [result.entry.id, result.kind]),
    );
}

describe("searchSettings", () => {
    it("gives nothing for an empty or meaningless query", () => {
        expect(searchSettings("")).toEqual([]);
        expect(searchSettings("   ")).toEqual([]);
        expect(searchSettings("the settings for my")).toEqual([]);
    });

    it("matches a section by its exact name, ignoring case and punctuation", () => {
        const results = searchSettings("Bring your own keys!");
        expect(ids(results)[0]).toBe("byok");
        expect(results[0].kind).toBe("exact");
    });

    it("counts a whole phrase inside a name as exact, not a fragment of a word", () => {
        expect(kinds(searchSettings("dark"))["appearance-dark-mode"]).toBe(
            "exact",
        );
        // "ark" is inside "dark" but is not a word of it.
        expect(kinds(searchSettings("ark"))["appearance-dark-mode"]).toBeUndefined();
    });

    it("finds Bring Your Own Keys from the words people use for it", () => {
        for (const query of ["api key", "anthropic", "openai key", "where do I add my claude key", "BYOK"]) {
            expect(ids(searchSettings(query)), query).toContain("byok");
        }
        expect(ids(searchSettings("api key"))[0]).toBe("byok");
    });

    it("finds Security from 2FA and authenticator jargon", () => {
        for (const query of ["2fa", "two factor", "authenticator app", "totp"]) {
            expect(ids(searchSettings(query))[0], query).toBe("security-mfa");
        }
    });

    it("ranks an exact title hit above a keyword hit on another entry", () => {
        // "Memory" is a title; it is also a keyword of the memory-model entry.
        const results = searchSettings("memory");
        expect(results[0].entry.id).toBe("memory");
        expect(results[0].kind).toBe("exact");
        expect(ids(results)).toContain("models-memory");
    });

    it("puts exact matches before related ones whatever their score", () => {
        const results = searchSettings("delete");
        const firstRelated = results.findIndex((r) => r.kind === "related");
        const lastExact = results.map((r) => r.kind).lastIndexOf("exact");
        expect(lastExact).toBeGreaterThanOrEqual(0);
        if (firstRelated >= 0) expect(lastExact).toBeLessThan(firstRelated);
        expect(ids(results)).toEqual(
            expect.arrayContaining(["account-delete", "privacy-delete"]),
        );
    });

    it("survives a typo", () => {
        expect(ids(searchSettings("pasword"))).toContain("security-password");
        expect(ids(searchSettings("apearance"))).toContain("appearance-dark-mode");
        expect(ids(searchSettings("conectors"))).toContain("connectors-installed");
    });

    it("does not treat a known word as a typo of another", () => {
        expect(ids(searchSettings("model"))).not.toContain("appearance-dark-mode");
    });

    it("orders exact keyword hits by how much of the keyword the query fills", () => {
        // "google" is all of a Bring Your Own Keys keyword and part of
        // Security's "google authenticator".
        const results = ids(searchSettings("google"));
        expect(results.indexOf("byok")).toBeLessThan(results.indexOf("security-mfa"));
        expect(results.indexOf("connectors-discover")).toBeLessThan(results.indexOf("security-mfa"));
    });

    it("keeps a query with one unknown word", () => {
        expect(ids(searchSettings("gpt-4"))).toEqual(["byok"]);
        expect(ids(searchSettings("exporting"))).toContain("privacy-export");
    });

    it("folds plurals and British spelling into one word", () => {
        expect(ids(searchSettings("organisations"))[0]).toBe("organizations");
        expect(ids(searchSettings("connector"))).toContain("connectors-discover");
        expect(ids(searchSettings("invitations"))[0]).toBe("organizations-invitations");
    });

    it("matches a word typed only part way", () => {
        expect(ids(searchSettings("pass"))).toContain("security-password");
        expect(ids(searchSettings("expo"))).toContain("privacy-export");
    });

    it("does not return every entry for a vague multi-word query", () => {
        const results = searchSettings("google drive connector");
        expect(results[0].entry.id).toBe("connectors-discover");
        expect(results.length).toBeLessThan(SETTINGS_SEARCH_ENTRIES.length / 2);
    });

    it("searches only the entries it is given", () => {
        const subset = SETTINGS_SEARCH_ENTRIES.filter(
            (entry) => entry.tabId !== "privacy-data",
        );
        expect(ids(searchSettings("export", subset))).not.toContain(
            "privacy-export",
        );
    });

    it("has unique ids and a href under /settings for every entry", () => {
        const seen = new Set<string>();
        for (const entry of SETTINGS_SEARCH_ENTRIES) {
            expect(seen.has(entry.id), entry.id).toBe(false);
            seen.add(entry.id);
            expect(entry.href.startsWith("/settings")).toBe(true);
        }
    });
});

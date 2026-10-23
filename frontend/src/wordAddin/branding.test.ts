/**
 * The Word add-in's product name, exercised from the frontend test runner.
 * webpack's EnvironmentPlugin bakes REACT_APP_APP_NAME into the bundle; an
 * unset or blank value keeps Mike's name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
    vi.resetModules();
    return import("../../../word-addin/src/shared/branding");
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("Word add-in branding", () => {
    it("is Mike when unset or blank", async () => {
        vi.stubEnv("REACT_APP_APP_NAME", "  ");
        expect((await load()).APP_NAME).toBe("Mike");
    });

    it("reads REACT_APP_APP_NAME", async () => {
        vi.stubEnv("REACT_APP_APP_NAME", "Acme Assist");
        expect((await load()).APP_NAME).toBe("Acme Assist");
    });
});

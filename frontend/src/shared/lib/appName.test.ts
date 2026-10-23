import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
    vi.resetModules();
    return import("./appName");
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("appName", () => {
    it("is Mike when neither build sets a name", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "");
        vi.stubEnv("REACT_APP_APP_NAME", "");
        expect((await load()).APP_NAME).toBe("Mike");
    });

    it("takes the web app's name", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "Acme Assist");
        vi.stubEnv("REACT_APP_APP_NAME", "");
        expect((await load()).APP_NAME).toBe("Acme Assist");
    });

    it("ignores the Word add-in's variable; its build maps it to NEXT_PUBLIC_APP_NAME itself", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "");
        vi.stubEnv("REACT_APP_APP_NAME", "Acme Assist");
        expect((await load()).APP_NAME).toBe("Mike");
    });
});

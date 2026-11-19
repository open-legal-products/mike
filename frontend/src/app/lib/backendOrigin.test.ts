import { afterEach, describe, expect, it, vi } from "vitest";
import { backendOrigin } from "./backendOrigin";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("backendOrigin", () => {
    it("uses the configured API, without a trailing slash", () => {
        vi.stubEnv("API_BASE_URL", " https://backend.example.test/base/ ");
        expect(backendOrigin()).toBe("https://backend.example.test/base");
    });

    it("falls back to the local API outside production", () => {
        vi.stubEnv("API_BASE_URL", "");
        expect(backendOrigin()).toBe("http://localhost:3001");
    });

    it("refuses to guess in production", () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("API_BASE_URL", "");
        expect(() => backendOrigin()).toThrow("API_BASE_URL is required at runtime.");
    });

    it("rejects an address that is not http or https", () => {
        vi.stubEnv("API_BASE_URL", "ftp://backend.example.test");
        expect(() => backendOrigin()).toThrow("API_BASE_URL must use http or https.");
    });
});

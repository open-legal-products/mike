import { afterEach, describe, expect, it } from "vitest";
import { configuredLoopbackOrigin } from "./researchPack.routes";

const original = process.env.API_PUBLIC_URL;

afterEach(() => {
    if (original === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = original;
});

describe("research pack trusted origin", () => {
    it("accepts the configured loopback API path while comparing its origin", () => {
        process.env.API_PUBLIC_URL = "http://127.0.0.1:5400/api";
        expect(configuredLoopbackOrigin()).toBe("http://127.0.0.1:5400");
        process.env.API_PUBLIC_URL = "http://127.0.0.1:5400/api/";
        expect(configuredLoopbackOrigin()).toBe("http://127.0.0.1:5400");
    });

    it("rejects non-loopback or credential-bearing configuration", () => {
        process.env.API_PUBLIC_URL = "https://example.test/api";
        expect(configuredLoopbackOrigin()).toBeNull();
        process.env.API_PUBLIC_URL = "http://user:pass@127.0.0.1:5400/api";
        expect(configuredLoopbackOrigin()).toBeNull();
    });
});

import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
    vi.resetModules();
    return import("./branding");
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("branding", () => {
    it("is Mike's name, tagline and home page when unset", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "");
        vi.stubEnv("NEXT_PUBLIC_APP_TAGLINE", "");
        vi.stubEnv("NEXT_PUBLIC_APP_HOME_URL", "");
        vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
        vi.stubEnv("NEXT_PUBLIC_APP_DESCRIPTION", "");
        vi.stubEnv("NEXT_PUBLIC_APP_DOMAIN", "");
        const branding = await load();
        expect(branding.APP_NAME).toBe("Mike");
        expect(branding.APP_TAGLINE).toBe("Legal AI Platform");
        expect(branding.APP_HOME_URL).toBe("https://mikeoss.com");
        expect(branding.appTitle()).toBe("Mike");
        expect(branding.appTitle(branding.APP_TAGLINE)).toBe("Mike - Legal AI Platform");
        expect(branding.APP_URL).toBe("https://app.mikeoss.com");
        expect(branding.APP_DESCRIPTION).toBe(
            "AI-powered legal document analysis and contract review platform.",
        );
        expect(branding.APP_DOMAIN).toBe("legal");
        expect(branding.APP_DISCLAIMER).toBe(
            "AI can make mistakes. Answers are not legal advice.",
        );
    });

    it("names the app's own field in the disclaimer", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_DOMAIN", "  tax ");
        const branding = await load();
        expect(branding.APP_DOMAIN).toBe("tax");
        expect(branding.APP_DISCLAIMER).toBe(
            "AI can make mistakes. Answers are not tax advice.",
        );
    });

    it("reads the app's own URL and description", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
        vi.stubEnv("NEXT_PUBLIC_APP_DESCRIPTION", "AI for tax work.");
        const branding = await load();
        expect(branding.APP_URL).toBe("https://app.example.com");
        expect(branding.APP_DESCRIPTION).toBe("AI for tax work.");
    });

    it("reads the environment", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "Acme Assist");
        vi.stubEnv("NEXT_PUBLIC_APP_TAGLINE", "AI platform for tax teams");
        vi.stubEnv("NEXT_PUBLIC_APP_HOME_URL", "https://example.com");
        const branding = await load();
        expect(branding.APP_NAME).toBe("Acme Assist");
        expect(branding.APP_HOME_URL).toBe("https://example.com");
        expect(branding.appTitle(branding.APP_TAGLINE)).toBe(
            "Acme Assist - AI platform for tax teams",
        );
    });

    it("falls back on whitespace and trims", async () => {
        vi.stubEnv("NEXT_PUBLIC_APP_NAME", "   ");
        vi.stubEnv("NEXT_PUBLIC_APP_TAGLINE", "  Tagline  ");
        const branding = await load();
        expect(branding.APP_NAME).toBe("Mike");
        expect(branding.APP_TAGLINE).toBe("Tagline");
    });
});

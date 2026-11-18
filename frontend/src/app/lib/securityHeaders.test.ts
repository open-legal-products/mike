// @vitest-environment node
// next.config.ts is a Node module (it imports Sentry's build plugin), so it
// is loaded here the way `next build` loads it, not inside jsdom.
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config";
import { STANDARD_FONT_DATA_URL } from "../components/shared/views/highlightQuote";

/**
 * The headers next.config.ts attaches to `path`. Each rule's source is
 * compiled the way `next build` writes it into routes-manifest.json.
 */
async function headersFor(path: string): Promise<Record<string, string>> {
    expect(nextConfig.headers, "next.config.ts defines no headers()").toBeTypeOf(
        "function",
    );
    const rules = await nextConfig.headers!();
    const matching = rules.filter((rule) =>
        new RegExp(buildCustomRoute("header", rule).regex).test(path),
    );
    return Object.fromEntries(
        matching.flatMap((rule) => rule.headers.map((h) => [h.key, h.value])),
    );
}

/** The headers on an ordinary page such as /login. */
const pageHeaders = () => headersFor("/login");

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("web app security headers", () => {
    it("forbids framing, sniffing and plain-http downgrades in production", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const headers = await pageHeaders();

        expect(headers["X-Frame-Options"]).toBe("DENY");
        expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
        expect(headers["X-Content-Type-Options"]).toBe("nosniff");
        expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
        expect(headers["Permissions-Policy"]).toContain("camera=()");
        expect(headers["Strict-Transport-Security"]).toMatch(/^max-age=\d{7,}/);
        // The script policy is not enforced yet (no nonces), only reported.
        expect(headers["Content-Security-Policy"]).not.toContain("script-src");
        expect(headers["Content-Security-Policy-Report-Only"]).toContain("script-src 'self'");
        expect(headers["Content-Security-Policy-Report-Only"]).not.toContain("'unsafe-eval'");
    });

    it("does not send HSTS from the development server", async () => {
        vi.stubEnv("NODE_ENV", "development");
        const headers = await pageHeaders();

        expect(headers["Strict-Transport-Security"]).toBeUndefined();
        expect(headers["X-Frame-Options"]).toBe("DENY");
    });

    it("leaves the API proxy's own headers alone", async () => {
        // /api/* is forwarded from the backend, whose helmet headers are
        // stricter (Referrer-Policy: no-referrer keeps OAuth codes out of
        // referrers). A page rule would overwrite them.
        vi.stubEnv("NODE_ENV", "production");
        expect(await headersFor("/")).toHaveProperty("X-Frame-Options", "DENY");
        expect(await headersFor("/_next/static/chunks/app.js")).toHaveProperty(
            "X-Frame-Options",
            "DENY",
        );
        expect(
            await headersFor("/api/user/integrations/gmail/oauth/callback"),
        ).toEqual({});
    });

    it("lets the PDF viewer load pdf.js standard fonts under the report-only policy", async () => {
        // PdfView passes STANDARD_FONT_DATA_URL to pdf.js, which loads the
        // standard fonts from that origin; a font-src without it reports (and,
        // once enforced, would block) them on PDF previews.
        vi.stubEnv("NODE_ENV", "production");
        const policy = (await pageHeaders())["Content-Security-Policy-Report-Only"];
        const fontSrc = policy
            .split(";")
            .map((directive) => directive.trim())
            .find((directive) => directive.startsWith("font-src "));

        expect(fontSrc?.split(" ")).toContain(new URL(STANDARD_FONT_DATA_URL).origin);
    });

    it("does not advertise the framework", () => {
        expect(nextConfig.poweredByHeader).toBe(false);
    });
});

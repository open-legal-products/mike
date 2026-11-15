// @vitest-environment node
// next.config.ts is a Node module (it imports Sentry's build plugin), so it
// is loaded here the way `next build` loads it, not inside jsdom.
import { readFileSync } from "node:fs";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config";

const PUBLIC_HEADERS_FILE = new URL("../../../public/_headers", import.meta.url);

/**
 * The headers next.config.ts attaches to `path`. Each rule's source is
 * compiled the way `next build` writes it into routes-manifest.json, which is
 * also what OpenNext matches against on Cloudflare.
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

/** The header lines public/_headers applies to every static file. */
function staticFileHeaders(): Record<string, string> {
    const lines = readFileSync(PUBLIC_HEADERS_FILE, "utf8").split("\n");
    const start = lines.findIndex((line) => line.trim() === "/*");
    expect(start, "public/_headers has no /* block").toBeGreaterThanOrEqual(0);
    const headers: Record<string, string> = {};
    for (const line of lines.slice(start + 1)) {
        if (!/^\s+\S/.test(line)) break;
        const [key, ...value] = line.trim().split(":");
        headers[key] = value.join(":").trim();
    }
    return headers;
}

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

    it("does not advertise the framework", () => {
        expect(nextConfig.poweredByHeader).toBe(false);
    });

    it("gives static files on Cloudflare the same protections as pages", async () => {
        // Workers Static Assets serves public/ and /_next/static before the
        // Next server runs, so next.config.ts headers never reach them.
        vi.stubEnv("NODE_ENV", "production");
        const pages = await pageHeaders();
        const statics = staticFileHeaders();

        for (const key of [
            "Content-Security-Policy",
            "X-Frame-Options",
            "X-Content-Type-Options",
            "Referrer-Policy",
            "Strict-Transport-Security",
        ]) {
            expect(statics[key], key).toBe(pages[key]);
        }
    });
});

/**
 * Response headers every web-app page carries (next.config.ts `headers()`).
 *
 * The Express API already sends its own strict set through helmet
 * (backend/src/app.ts); this is the web app's half. The session is an
 * HttpOnly cookie and the pages render privileged documents, so the two
 * attacks that matter most are being framed by another site (clickjacking)
 * and script injection.
 *
 * Framing is blocked outright: nothing loads these pages in a frame. The
 * Word add-in is its own bundle and only opens the web app in a browser
 * window, and the OAuth/connector flows use popups, not iframes.
 *
 * Script injection is not blocked yet. An enforced script policy for a Next
 * app needs a per-request nonce (middleware), and this app has none, so the
 * full policy below ships as Content-Security-Policy-Report-Only: browsers
 * log what it would block without blocking it. Only the low-risk directives
 * are enforced.
 *
 * On Cloudflare (OpenNext), static files are served before the Next server
 * runs and never see these headers; public/_headers repeats the ones that
 * matter for them, and securityHeaders.test.ts keeps the two in step.
 */

export type HeaderEntry = { key: string; value: string };

/** 180 days, matching the API's helmet HSTS setting. */
const HSTS = "max-age=15552000; includeSubDomains";

/**
 * Enforced. None of these can break a page: the app has no <base> tag, no
 * <object>/<embed>, and is never framed.
 */
const ENFORCED_CSP = [
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
].join("; ");

/**
 * Report-only: the policy the app is expected to satisfy, derived from what
 * the code loads. Each origin is here for a named reason:
 * - 'unsafe-inline' scripts: Next's inline bootstrap scripts (no nonces yet).
 * - 'wasm-unsafe-eval': the DOCX editor's HarfBuzz text shaper.
 * - apis.google.com, docs.google.com: the Google Picker (lib/googlePicker.ts).
 * - static.cloudflareinsights.com: Cloudflare's injected analytics beacon,
 *   which posts back to the same origin (/cdn-cgi/rum).
 * - cdn.jsdelivr.net fonts: the DOCX editor's font fallback.
 * - unpkg.com fonts: pdf.js standard fonts for PDF previews
 *   (STANDARD_FONT_DATA_URL in components/shared/views/highlightQuote.ts).
 * - connect-src https:: uploads go straight to the storage provider through a
 *   signed URL whose origin depends on the deployment.
 * - blob:/data:: document previews, downloads and the pdf.js worker.
 * Sentry posts to the same-origin /monitoring tunnel, so it needs nothing.
 */
function reportOnlyCsp(production: boolean): string {
    return [
        "default-src 'self'",
        [
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
            // React's development build evaluates code for fast refresh.
            ...(production ? [] : ["'unsafe-eval'"]),
            "https://apis.google.com https://static.cloudflareinsights.com",
        ].join(" "),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: blob: https://cdn.jsdelivr.net https://unpkg.com",
        "connect-src 'self' blob: data: https:",
        "media-src 'self' blob: data:",
        "worker-src 'self' blob:",
        "frame-src 'self' blob: https://docs.google.com",
        "form-action 'self'",
        ENFORCED_CSP,
    ].join("; ");
}

export function securityHeaders(production: boolean): HeaderEntry[] {
    return [
        { key: "Content-Security-Policy", value: ENFORCED_CSP },
        {
            key: "Content-Security-Policy-Report-Only",
            value: reportOnlyCsp(production),
        },
        // For browsers that predate frame-ancestors.
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        // The browser default, made explicit. Stricter values would strip the
        // origin Google checks against the Picker's referrer-restricted key.
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        },
        // Browsers ignore HSTS over plain http, but leave it out of `next dev`
        // anyway so a local https setup is never pinned.
        ...(production
            ? [{ key: "Strict-Transport-Security", value: HSTS }]
            : []),
    ];
}

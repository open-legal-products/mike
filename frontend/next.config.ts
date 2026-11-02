import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { releaseName } from "./src/shared/lib/releaseName.cjs";

const nextConfig: NextConfig = {
    /* config options here */
    // Standalone output emits a self-contained server (server.js + traced
    // node_modules) that runs without the repo — the desktop app bundles it
    // and runs it under Electron's own Node. Opt-in so the Docker image and
    // dev workflow are untouched.
    ...(process.env.NEXT_OUTPUT_STANDALONE === "1"
        ? { output: "standalone" as const }
        : {}),
    reactCompiler: true,
    typescript: {
        // `next build` type-checks this program instead of tsconfig.json. It
        // excludes test files, so the production image (built from an
        // allowlisted Docker context, see Dockerfile) never depends on test
        // fixtures or sibling apps. Tests are type-checked by `npm run
        // typecheck` (tsc over tsconfig.json) in CI instead.
        tsconfigPath: "tsconfig.build.json",
    },
    turbopack: {
        root: __dirname,
    },
    async rewrites() {
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
        ];
    },
    async redirects() {
        return [
            {
                source: "/account",
                destination: "/settings",
                permanent: true,
            },
            {
                source: "/account/:path*",
                destination: "/settings/:path*",
                permanent: true,
            },
        ];
    },
    skipTrailingSlashRedirect: true,
};

// Sentry's build plugin wires the instrumentation files above into the
// bundle. Source-map upload (readable stack traces in Sentry) only happens
// when SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT are present at build
// time; without them the build is unchanged and no maps leave the machine.
const sourceMapUploadConfigured = Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
        process.env.SENTRY_ORG &&
        process.env.SENTRY_PROJECT,
);

// The release the maps are uploaded under must be the string the SDKs tag
// events with (frontend/src/shared/lib/sentryEvent.ts reads the same
// variables at runtime), or Sentry files the maps under a release no event
// carries. MIKE_VERSION and GIT_SHA are the image build arguments.
const release = releaseName(
    process.env.SENTRY_RELEASE ?? process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    process.env.MIKE_VERSION,
    process.env.GIT_SHA,
);

export default withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.CI,
    telemetry: false,
    release: { name: release },
    sourcemaps: {
        disable: !sourceMapUploadConfigured,
        // Upload the maps for debugging, then keep them out of the image.
        deleteSourcemapsAfterUpload: true,
    },
    widenClientFileUpload: sourceMapUploadConfigured,
    // No `tunnelRoute` here: the browser SDK posts to /monitoring explicitly
    // (SENTRY_TUNNEL_PATH in app/lib/errorReporting.ts) and
    // app/monitoring/route.ts forwards the envelope after applying the
    // deployment's runtime opt-out and DSN. That is what lets a published
    // image honour SENTRY_DISABLED and FRONTEND_SENTRY_DSN without a rebuild.
});

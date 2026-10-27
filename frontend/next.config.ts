import path from "node:path";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

// The repository root: the parent of this directory, here and in the Docker
// image (frontend/Dockerfile mirrors the layout at /app/frontend and
// /app/packages). The shared packages the app imports, @mike/ui and
// @mike/client (packages/ui, packages/client), live there.
const REPO_ROOT = path.resolve(__dirname, "..");

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
        // Turbopack resolves nothing outside its root, and Next uses the same
        // directory as outputFileTracingRoot (the two must agree). The root
        // is therefore the repository, so the tsconfig `paths` aliases for the
        // shared packages resolve; standalone output nests under frontend/.
        root: REPO_ROOT,
    },
    experimental: {
        // Webpack builds (`next build --webpack`, used for the desktop app's
        // standalone server) transpile only files under this directory unless
        // told otherwise; the shared packages live one level up.
        externalDir: true,
    },
    webpack: (config) => {
        // The shared packages have no node_modules of their own. A bare import
        // from a file under packages/ walks up to the repository root and never
        // reaches this directory's node_modules, so add it as the fallback
        // (word-addin/webpack.config.js does the same for the add-in).
        config.resolve.modules = [
            ...(config.resolve.modules ?? ["node_modules"]),
            path.join(__dirname, "node_modules"),
        ];
        return config;
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

export default withSentryConfig(nextConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !process.env.CI,
    telemetry: false,
    sourcemaps: {
        disable: !sourceMapUploadConfigured,
        // Upload the maps for debugging, then keep them out of the image.
        deleteSourcemapsAfterUpload: true,
    },
    widenClientFileUpload: sourceMapUploadConfigured,
    // Route browser events through this origin so ad blockers that block
    // *.sentry.io do not hide client-side errors. Only applies to sentry.io
    // DSNs; self-hosted or local DSNs post directly.
    tunnelRoute: "/monitoring",
});

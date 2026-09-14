import type { NextConfig } from "next";

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

export default nextConfig;

// EigenPal's HarfBuzz loader uses top-level await. This local comparison
// catalog targets the same modern browsers as the application.
export default {
    // The shared API client imports Next's Sentry adapter. Supply an empty
    // browser environment in this standalone catalog, never host env values.
    define: { "process.env": "{}" },
    build: { target: "esnext" },
    optimizeDeps: {
        // Preserve import.meta.url relative font assets during development.
        exclude: ["@docx-editor.dev/fonts", "@docx-editor.dev/core", "@docx-editor.dev/react"],
        esbuildOptions: { target: "esnext" },
    },
};

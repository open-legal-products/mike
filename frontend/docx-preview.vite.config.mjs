// The standalone DOCX catalog targets the same modern browsers as the app.
const config = {
    // Supply an empty browser environment for Next's Sentry adapter.
    define: { "process.env": "{}" },
    build: { target: "esnext" },
    optimizeDeps: {
        // Preserve EigenPal's import.meta.url font and WASM assets.
        exclude: ["@docx-editor.dev/fonts", "@docx-editor.dev/core", "@docx-editor.dev/react"],
        esbuildOptions: { target: "esnext" },
    },
};

export default config;

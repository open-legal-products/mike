// The standalone DOCX catalog targets the same modern browsers as the app.
const config = {
    // Supply an empty browser environment for Next's Sentry adapter.
    define: { "process.env": "{}" },
    build: { target: "esnext" },
    optimizeDeps: { esbuildOptions: { target: "esnext" } },
};

export default config;

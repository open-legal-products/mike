// The feature preview imports mikeApi; use Sentry's browser SDK outside Next.
const config = {
    define: { "process.env": "{}" },
    resolve: {
        alias: [{ find: /^@sentry\/nextjs$/, replacement: "@sentry/react" }],
    },
};

export default config;

// Browser-side Sentry bootstrap. Next.js loads this file before any page
// code runs, so errors thrown during hydration are already covered. The
// NEXT_PUBLIC_* references must stay literal: Next inlines them at build
// time. Reporting policy and destination are enforced at runtime by the
// same-origin tunnel, including when the image was built with reporting off.
import * as Sentry from "@sentry/nextjs";
import { browserSentryOptions } from "@/app/lib/errorReporting";

Sentry.init(
    browserSentryOptions({
        install: process.env.NEXT_PUBLIC_SENTRY_INSTALL,
        environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
        release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
        version: process.env.NEXT_PUBLIC_MIKE_VERSION,
        gitSha: process.env.NEXT_PUBLIC_GIT_SHA,
        tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
        nodeEnv: process.env.NODE_ENV,
    }),
);

// Lets Sentry attribute an error to the client-side navigation it happened in.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

// The product's name, tagline and home page, read from the build environment
// so a deployment can rebrand the web app without a code change. Next.js
// inlines NEXT_PUBLIC_* values at build time only when they are read with
// literal `process.env.NEXT_PUBLIC_…` expressions, so each is spelled out.
// Unset or blank values fall back to Mike's own.

import { APP_NAME } from "./appName";

/** The product name shown in the interface (NEXT_PUBLIC_APP_NAME); see appName.ts. */
export { APP_NAME };

function orDefault(value: string | undefined, fallback: string): string {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
}

/** The phrase after the name in page titles (NEXT_PUBLIC_APP_TAGLINE). */
export const APP_TAGLINE = orDefault(
    process.env.NEXT_PUBLIC_APP_TAGLINE,
    "Legal AI Platform",
);

/** Where the logo links in production (NEXT_PUBLIC_APP_HOME_URL). */
export const APP_HOME_URL = orDefault(
    process.env.NEXT_PUBLIC_APP_HOME_URL,
    "https://mikeoss.com",
);

/** The app's own public address, for link previews (NEXT_PUBLIC_APP_URL). */
export const APP_URL = orDefault(
    process.env.NEXT_PUBLIC_APP_URL,
    "https://app.mikeoss.com",
);

/** One sentence for search results and link previews (NEXT_PUBLIC_APP_DESCRIPTION). */
export const APP_DESCRIPTION = orDefault(
    process.env.NEXT_PUBLIC_APP_DESCRIPTION,
    "AI-powered legal document analysis and contract review platform.",
);

/** The field the app works in, as in "not legal advice" (NEXT_PUBLIC_APP_DOMAIN). */
export const APP_DOMAIN = orDefault(process.env.NEXT_PUBLIC_APP_DOMAIN, "legal");

/** The line under the chat box. */
export const APP_DISCLAIMER = `AI can make mistakes. Answers are not ${APP_DOMAIN} advice.`;

/** A page title: the product name, then the suffix when there is one. */
export function appTitle(suffix?: string): string {
    return suffix ? `${APP_NAME} - ${suffix}` : APP_NAME;
}

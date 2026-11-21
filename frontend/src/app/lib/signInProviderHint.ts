import { backendOrigin } from "@/app/lib/backendOrigin";

/** Which provider buttons the sign-in screens should draw in their first paint. */
export interface SignInProviderHint {
    google: boolean;
    sso: boolean;
}

/** How long a rendered sign-in screen may keep its hint before it is re-read. */
export const SIGN_IN_PROVIDER_HINT_TTL_SECONDS = 60;

/**
 * Server-side read of the deployment's sign-in providers, so the login and
 * sign-up screens are rendered with their provider buttons already in place
 * instead of growing when the browser's own check answers.
 *
 * Only a hint: the browser still asks (useSignInOptions) and its answer
 * wins. `null` means "unknown" (no API at build time, an outage, a slow
 * answer), and the screens then wait for the browser's answer as before.
 * First-run setup and sign-up availability are deliberately left out: a
 * stale answer for those would redirect, not merely draw a button.
 */
export async function readSignInProviderHint(): Promise<SignInProviderHint | null> {
    try {
        const response = await fetch(`${backendOrigin()}/auth/options`, {
            next: { revalidate: SIGN_IN_PROVIDER_HINT_TTL_SECONDS },
            signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { google?: unknown; sso?: unknown };
        if (typeof body.google !== "boolean" || typeof body.sso !== "boolean") {
            return null;
        }
        return { google: body.google, sso: body.sso };
    } catch {
        // The browser's own check reports a failing API; this one stays quiet.
        return null;
    }
}

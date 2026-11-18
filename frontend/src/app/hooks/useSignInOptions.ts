"use client";

import { useEffect, useState } from "react";
import { getSignInOptions, type SignInOptions } from "@/app/lib/authApi";

/**
 * What the sign-in screens offered before the deployment could say: both
 * provider buttons, no setup screen. Used while the answer is unknown or
 * could not be read, so a failed check never hides a working provider.
 */
export const DEFAULT_SIGN_IN_OPTIONS: SignInOptions = {
    google: true,
    sso: true,
    setupRequired: false,
};

/**
 * Ask the API which sign-in routes this deployment offers (Google and SSO
 * only when configured) and whether it still needs its first account.
 * `loaded` stays false until the answer arrives, so callers can avoid
 * flashing buttons that are about to disappear.
 */
export function useSignInOptions(): { options: SignInOptions; loaded: boolean } {
    const [state, setState] = useState<{ options: SignInOptions; loaded: boolean }>({
        options: DEFAULT_SIGN_IN_OPTIONS,
        loaded: false,
    });

    useEffect(() => {
        let cancelled = false;
        getSignInOptions()
            .then((options) => {
                if (!cancelled) setState({ options, loaded: true });
            })
            .catch(() => {
                // Reported by the auth client; keep the defaults.
                if (!cancelled) setState({ options: DEFAULT_SIGN_IN_OPTIONS, loaded: true });
            });
        return () => {
            cancelled = true;
        };
    }, []);

    return state;
}

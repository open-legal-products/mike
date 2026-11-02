"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { needsMfaVerification } from "../popups/MfaVerificationPopup";

type GateState = "idle" | "checking" | "required" | "verified";
const MFA_VERIFIED_AT_KEY = "mike:mfa-verified-at";
const MFA_VERIFIED_GRACE_MS = 60_000;

export function MfaLoginGate({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const { profile, loading } = useUserProfile();
    const [gateState, setGateState] = useState<GateState>("idle");
    const isVerifyPage = pathname === "/verify-mfa";

    useEffect(() => {
        if (!user) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- sync fast paths of the async MFA check effect
            setGateState("idle");
            return;
        }
        if (loading) {
            return;
        }
        if (!profile?.mfaOnLogin) {
            setGateState("idle");
            return;
        }

        if (hasRecentMfaVerification()) {
            setGateState("verified");
            return;
        }

        let cancelled = false;
        setGateState((previous) =>
            previous === "verified" ? "verified" : "checking",
        );

        async function checkLoginMfa() {
            try {
                const required = await needsMfaVerification();
                if (cancelled) return;
                setGateState(required ? "required" : "verified");
            } catch {
                // Fail closed: if the assurance check can't be reached we
                // assume verification is still owed. The verify page runs the
                // same call and reports the real failure there, so this stays
                // silent rather than raising a second notice for one outage.
                if (!cancelled) setGateState("required");
            }
        }

        void checkLoginMfa();

        return () => {
            cancelled = true;
        };
    }, [loading, profile?.mfaOnLogin, user?.id]);

    useEffect(() => {
        if (!user || loading || !profile?.mfaOnLogin) return;

        if (gateState === "required" && !isVerifyPage) {
            if (hasRecentMfaVerification()) {
                // eslint-disable-next-line react-hooks/set-state-in-effect -- clear gate when a recent MFA verification exists instead of redirecting
                setGateState("verified");
                return;
            }
            const search = searchParams.toString();
            const next = `${pathname}${search ? `?${search}` : ""}`;
            router.replace(`/verify-mfa?next=${encodeURIComponent(next)}`);
        } else if (gateState === "verified" && isVerifyPage) {
            const next = safeNextPath(searchParams.get("next"));
            router.replace(next);
        }
    }, [
        gateState,
        isVerifyPage,
        loading,
        pathname,
        profile?.mfaOnLogin,
        router,
        searchParams,
        user,
    ]);

    if (user && loading) {
        return gateState === "verified" ? (
            <>{children}</>
        ) : (
            <FullScreenLoader />
        );
    }

    if (user && profile?.mfaOnLogin) {
        if (gateState === "required" && isVerifyPage) {
            return <>{children}</>;
        }
        if (gateState === "verified" && isVerifyPage) {
            return <FullScreenLoader />;
        }
        if (gateState === "verified") {
            return <>{children}</>;
        }
        if (gateState === "required" && !isVerifyPage) {
            return <FullScreenLoader />;
        }
        return <FullScreenLoader />;
    }

    return <>{children}</>;
}

function safeNextPath(value: string | null) {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
        return "/assistant";
    }
    if (value.startsWith("/verify-mfa")) return "/assistant";
    return value;
}

export function markMfaVerifiedForGate() {
    try {
        window.sessionStorage.setItem(MFA_VERIFIED_AT_KEY, String(Date.now()));
    } catch {
        // Storage is blocked (private mode, locked-down browser). The grace
        // window is only an optimisation: without it the gate re-checks with
        // the server, which is correct, just slower.
    }
}

function hasRecentMfaVerification() {
    let raw: string | null = null;
    try {
        raw = window.sessionStorage.getItem(MFA_VERIFIED_AT_KEY);
    } catch {
        // Same as above: no grace window, so fall through to a server check.
    }
    const verifiedAt = raw ? Number.parseInt(raw, 10) : 0;
    return (
        Number.isFinite(verifiedAt) &&
        Date.now() - verifiedAt < MFA_VERIFIED_GRACE_MS
    );
}

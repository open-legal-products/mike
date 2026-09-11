"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export function OnboardingGate({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const { user } = useAuth();
    const { profile, loading } = useUserProfile();
    const isOnboardingRoute = pathname.startsWith("/onboarding");
    // Credential-recovery pages must stay reachable even when onboarding is
    // incomplete: a recovery link logs the user in, and bouncing them to
    // onboarding here would discard the recovery session before they can set
    // a password (they'd stay locked out of their account forever).
    const isAuthTransitionRoute =
        pathname === "/login" ||
        pathname === "/login/sso" ||
        pathname === "/signup" ||
        pathname === "/signup/check-email" ||
        pathname === "/auth/callback" ||
        pathname === "/forgot-password" ||
        pathname === "/reset-password" ||
        pathname === "/verify-mfa";
    const needsOnboarding = profile?.onboardingComplete === false;

    useEffect(() => {
        if (!user || loading || !profile) return;

        if (needsOnboarding && !isOnboardingRoute && !isAuthTransitionRoute) {
            router.replace("/onboarding/profile");
            return;
        }
        if (!needsOnboarding && isOnboardingRoute) {
            router.replace("/assistant");
        }
    }, [
        isOnboardingRoute,
        isAuthTransitionRoute,
        loading,
        needsOnboarding,
        profile,
        router,
        user,
    ]);

    if (!user) return <>{children}</>;
    if (loading || !profile) return <FullScreenLoader />;
    if (needsOnboarding && !isOnboardingRoute && !isAuthTransitionRoute) {
        return <FullScreenLoader />;
    }
    if (!needsOnboarding && isOnboardingRoute) return <FullScreenLoader />;

    return <>{children}</>;
}

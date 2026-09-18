"use client";

import { Suspense } from "react";
import { AuthProvider } from "@/app/contexts/AuthContext";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";
import { MfaLoginGate } from "@/app/components/shared/MfaLoginGate";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { OnboardingGate } from "@/app/components/auth/OnboardingGate";
import { AppToasts } from "@/app/components/ui/toast";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <AuthProvider>
            <UserProfileProvider>
                <Suspense fallback={<FullScreenLoader />}>
                    <MfaLoginGate>
                        <OnboardingGate>{children}</OnboardingGate>
                    </MfaLoginGate>
                </Suspense>
                <AppToasts />
            </UserProfileProvider>
        </AuthProvider>
    );
}

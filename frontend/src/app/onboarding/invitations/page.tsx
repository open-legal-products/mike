"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingInvitations } from "@/app/components/auth/OnboardingInvitations";
import { OnboardingShell } from "@/app/components/auth/OnboardingShell";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

export default function OnboardingInvitationsPage() {
    const router = useRouter();
    const { user, authLoading } = useAuth();
    const { profile, loading } = useUserProfile();

    useEffect(() => {
        if (!authLoading && !user) router.replace("/login");
    }, [authLoading, router, user]);

    if (authLoading || loading || !user || !profile) {
        return <FullScreenLoader />;
    }

    return <InvitationStep key={user.id} userId={user.id} />;
}

function InvitationStep({ userId }: { userId: string }) {
    const router = useRouter();
    const [invitationsBusy, setInvitationsBusy] = useState(true);

    return (
        <OnboardingShell
            step="Step 3 of 4"
            title="Organization invitations"
        >
            <OnboardingInvitations
                userId={userId}
                disabled={false}
                onBusyChange={setInvitationsBusy}
            />
            <div className="flex items-center justify-between gap-3 pt-6">
                <PillButtonUI
                    type="button"
                    tone="white"
                    size="normal"
                    disabled={invitationsBusy}
                    onClick={() => router.push("/onboarding/practice")}
                >
                    Back
                </PillButtonUI>
                <PillButtonUI
                    type="button"
                    tone="black"
                    size="normal"
                    disabled={invitationsBusy}
                    onClick={() => router.push("/onboarding/models")}
                >
                    Continue
                </PillButtonUI>
            </div>
        </OnboardingShell>
    );
}

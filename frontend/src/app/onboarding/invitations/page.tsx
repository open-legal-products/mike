"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingInvitations } from "@/app/components/auth/OnboardingInvitations";
import { OnboardingShell } from "@/app/components/auth/OnboardingShell";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { PillButtonUI } from "@mike/ui";

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
    const { completeOnboarding } = useUserProfile();
    const [invitationsBusy, setInvitationsBusy] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(false);

    async function finish() {
        if (invitationsBusy || submitting) return;
        setSubmitting(true);
        setError(false);
        const saved = await completeOnboarding();
        if (saved) {
            router.replace("/assistant");
        } else {
            setError(true);
            setSubmitting(false);
        }
    }

    return (
        <OnboardingShell
            step="Step 3 of 3"
            title="Organization invitations"
        >
            <OnboardingInvitations
                userId={userId}
                disabled={submitting}
                onBusyChange={setInvitationsBusy}
            />
            <WarningPopup
                open={error}
                onClose={() => setError(false)}
                title="Unable to finish setup"
                message="Please try again."
            />
            <div className="flex items-center justify-between gap-3 pt-6">
                <PillButtonUI
                    type="button"
                    tone="white"
                    size="normal"
                    disabled={invitationsBusy || submitting}
                    onClick={() => router.push("/onboarding/practice")}
                >
                    Back
                </PillButtonUI>
                <PillButtonUI
                    type="button"
                    tone="black"
                    size="normal"
                    disabled={invitationsBusy || submitting}
                    onClick={() => void finish()}
                >
                    {submitting ? "Finishing..." : "Finish"}
                </PillButtonUI>
            </div>
        </OnboardingShell>
    );
}

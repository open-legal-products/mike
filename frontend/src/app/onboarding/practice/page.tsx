"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/app/components/auth/OnboardingShell";
import {
    PersonalisationFields,
    personalisationInitialValues,
    usePersonalisationFields,
} from "@/app/components/settings/PersonalisationFields";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export default function OnboardingPracticePage() {
    const router = useRouter();
    const { user, authLoading } = useAuth();
    const { profile, loading } = useUserProfile();

    useEffect(() => {
        if (!authLoading && !user) router.replace("/login");
    }, [authLoading, router, user]);

    if (authLoading || loading || !user || !profile) {
        return <FullScreenLoader />;
    }

    return (
        <PracticeDetailsForm
            key={user.id}
            initial={personalisationInitialValues(profile)}
        />
    );
}

function PracticeDetailsForm({
    initial,
}: {
    initial: ReturnType<typeof personalisationInitialValues>;
}) {
    const router = useRouter();
    const { completeOnboarding } = useUserProfile();
    const form = usePersonalisationFields(initial);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const finishOnboarding = async (
        details: Parameters<typeof completeOnboarding>[0],
    ) => {
        setSubmitting(true);
        setError(null);
        const saved = await completeOnboarding(details);
        if (saved) {
            router.replace("/assistant");
        } else {
            setError("Unable to save your practice details");
            setSubmitting(false);
        }
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (form.validationError) {
            setError(form.validationError);
            return;
        }

        await finishOnboarding({
            ...(form.details.jurisdiction
                ? { jurisdiction: form.details.jurisdiction }
                : {}),
            ...(form.details.practiceSetting
                ? { practiceSetting: form.details.practiceSetting }
                : {}),
            ...(form.details.professionalTitle
                ? { professionalTitle: form.details.professionalTitle }
                : {}),
            ...(form.details.practiceAreas?.length
                ? { practiceAreas: form.details.practiceAreas }
                : {}),
        });
    };

    return (
        <OnboardingShell
            step="Step 2 of 2"
            title="Your legal practice"
            description="Optionally add your professional setting, primary jurisdiction, and the areas you work in."
        >
            <form onSubmit={handleSubmit}>
                <PersonalisationFields
                    form={form}
                    order={[
                        "jurisdiction",
                        "professionalTitle",
                        "practiceSetting",
                        "practiceAreas",
                    ]}
                    className="space-y-4"
                />

                {error && (
                    <div
                        className="mt-4 rounded bg-red-50 p-3 text-sm text-red-600"
                        role="alert"
                    >
                        {error}
                    </div>
                )}

                <div className="flex items-center justify-between gap-3 pt-6">
                    <PillButtonUI
                        type="button"
                        tone="white"
                        size="normal"
                        disabled={submitting}
                        onClick={() => router.push("/onboarding/profile")}
                    >
                        Back
                    </PillButtonUI>
                    <div className="flex items-center gap-4">
                        <button
                            type="button"
                            disabled={submitting}
                            onClick={() => void finishOnboarding({})}
                            className="text-sm font-medium text-gray-500 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-300"
                        >
                            Skip
                        </button>
                        <PillButtonUI
                            type="submit"
                            tone="black"
                            size="normal"
                            disabled={submitting}
                        >
                            {submitting ? "Finishing..." : "Finish"}
                        </PillButtonUI>
                    </div>
                </div>
            </form>
        </OnboardingShell>
    );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OnboardingShell } from "@/app/components/auth/OnboardingShell";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { MODEL_API_KEY_FIELDS } from "@/app/components/settings/modelProviders";
import { PersonalProviderKeys } from "@/app/components/settings/PersonalProviderKeys";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    PERSONAL_WORKSPACE,
    readStoredWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { apiKeyStateFromStatus } from "@/app/lib/apiKeyState";
import { getOrgApiKeys, listOrgs, type ApiKeyState } from "@/app/lib/mikeApi";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

export default function OnboardingModelsPage() {
    const router = useRouter();
    const { user, authLoading } = useAuth();
    const { profile, loading } = useUserProfile();

    useEffect(() => {
        if (!authLoading && !user) router.replace("/login");
    }, [authLoading, router, user]);

    if (authLoading || loading || !user || !profile) {
        return <FullScreenLoader />;
    }

    return <ModelStep key={user.id} userId={user.id} />;
}

type KeySource = "user" | "org" | "env" | null;

/** Whether any model provider can run on the given keys, from the named source. */
function hasUsableProvider(
    keys: ApiKeyState | undefined,
    source?: Exclude<KeySource, null>,
): boolean {
    if (!keys) return false;
    return MODEL_API_KEY_FIELDS.some((field) => {
        const state = keys[field.provider];
        return (
            !!state?.configured &&
            state.enabled !== false &&
            (source === undefined || state.source === source)
        );
    });
}

/**
 * The organization the person accepted an invitation to in the previous
 * step, and whether it already has models to run on. Onboarding runs
 * outside the app's WorkspaceProvider, so the stored workspace is read and
 * resolved here. Null until known, or when there is nothing to say.
 */
function useJoinedOrganization(userId: string) {
    const [joined, setJoined] = useState<{
        name: string;
        hasModels: boolean;
    } | null>(null);

    useEffect(() => {
        const orgId = readStoredWorkspace(userId);
        if (orgId === PERSONAL_WORKSPACE) return;
        let cancelled = false;
        void Promise.all([listOrgs(), getOrgApiKeys(orgId)]).then(
            ([orgs, keys]) => {
                if (cancelled) return;
                const org = orgs.find((candidate) => candidate.id === orgId);
                if (!org) return;
                setJoined({
                    name: org.name,
                    hasModels: hasUsableProvider(
                        apiKeyStateFromStatus(keys.effective),
                    ),
                });
            },
            () => {
                // Unknown is not "no models": the step keeps its general
                // wording and the server still decides what may run.
            },
        );
        return () => {
            cancelled = true;
        };
    }, [userId]);

    return joined;
}

function stepDescription(
    keys: ApiKeyState | undefined,
    joined: { name: string; hasModels: boolean } | null,
): string {
    if (joined?.hasModels) {
        return `You joined ${joined.name}, and its models are available in that workspace, so you can finish now. Keys you add here are used in your Personal workspace only.`;
    }
    if (hasUsableProvider(keys, "user")) {
        return "Your key is saved. Add more providers now, or change them later in Settings.";
    }
    if (hasUsableProvider(keys, "env")) {
        return "This deployment already provides models, so you can finish now. A key you add here replaces the deployment's for your Personal workspace.";
    }
    return "Add an API key for at least one provider to start using Mike in your Personal workspace. You can add or change keys later in Settings.";
}

function ModelStep({ userId }: { userId: string }) {
    const router = useRouter();
    const { profile, completeOnboarding } = useUserProfile();
    const joined = useJoinedOrganization(userId);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(false);

    async function finish() {
        if (submitting) return;
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
            step="Step 4 of 4"
            title="Connect a model"
            description={stepDescription(profile?.apiKeys, joined)}
            width="wide"
        >
            <PersonalProviderKeys intro={null} />
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
                    disabled={submitting}
                    onClick={() => router.push("/onboarding/invitations")}
                >
                    Back
                </PillButtonUI>
                <PillButtonUI
                    type="button"
                    tone="black"
                    size="normal"
                    disabled={submitting}
                    onClick={() => void finish()}
                >
                    {submitting ? "Finishing..." : "Finish"}
                </PillButtonUI>
            </div>
        </OnboardingShell>
    );
}

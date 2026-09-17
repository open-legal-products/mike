"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { SiteLogo } from "@/app/components/site-logo";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { useAuth } from "@/app/contexts/AuthContext";
import { challengeAndVerifyMfa, listMfaFactors } from "@/app/lib/authApi";
import { authGlassCardClassName } from "@/app/components/auth/authStyles";
import {
    needsMfaVerification,
    VerificationCodeInput,
} from "@/app/components/popups/MfaVerificationPopup";
import { markMfaVerifiedForGate } from "@/app/components/shared/MfaLoginGate";

type MfaFactor = {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
};

export default function VerifyMfaPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user, authLoading, signOut } = useAuth();
    const [factors, setFactors] = useState<MfaFactor[]>([]);
    const [selectedFactorId, setSelectedFactorId] = useState("");
    const [code, setCode] = useState("");
    const [loading, setLoading] = useState(true);
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isMfaPreview =
        process.env.NODE_ENV !== "production" &&
        searchParams.get("preview") === "mfa";
    const displayedFactors = isMfaPreview
        ? [
              {
                  id: "preview-factor",
                  friendly_name: "Authenticator app",
                  factor_type: "totp",
              },
          ]
        : factors;
    const displayedFactorId = isMfaPreview
        ? "preview-factor"
        : selectedFactorId;
    const displayedLoading = isMfaPreview ? false : loading;

    const nextPath = safeNextPath(searchParams.get("next"));
    const canVerify =
        !displayedLoading &&
        !verifying &&
        !!displayedFactorId &&
        code.trim().length === 6;

    useEffect(() => {
        if (isMfaPreview) return;

        if (authLoading) return;
        if (!user) {
            router.replace("/login");
            return;
        }

        let cancelled = false;

        async function loadMfaState() {
            setLoading(true);
            setError(null);
            setCode("");
            try {
                const required = await needsMfaVerification();
                if (cancelled) return;
                if (!required) {
                    router.replace(nextPath);
                    return;
                }

                const data = await listMfaFactors();
                if (cancelled) return;

                const verified = (data.totp ?? []) as MfaFactor[];
                setFactors(verified);
                setSelectedFactorId(verified[0]?.id ?? "");
                if (verified.length === 0) {
                    setError(
                        "No verified authenticator factor is available for this account.",
                    );
                }
            } catch {
                if (cancelled) return;
                setError("Unable to load authenticator verification.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        void loadMfaState();

        return () => {
            cancelled = true;
        };
    }, [authLoading, isMfaPreview, nextPath, router, user]);

    async function verify() {
        if (!canVerify) return;

        setVerifying(true);
        setError(null);
        try {
            await challengeAndVerifyMfa(displayedFactorId, code.trim());
        } catch {
            setVerifying(false);
            setError("The verification code is invalid or expired.");
            return;
        }

        setVerifying(false);
        setCode("");
        markMfaVerifiedForGate();
        router.replace(nextPath);
    }

    async function cancel() {
        setError(null);
        try {
            await signOut();
            router.replace("/login");
        } catch {
            setError("Unable to sign out. Please try again.");
        }
    }

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute left-1/2 top-4 -translate-x-1/2 md:top-8">
                <SiteLogo size="lg" asLink />
            </div>
            <div className={`w-full max-w-md ${authGlassCardClassName}`}>
                <div className="mb-8 space-y-2">
                    <h1 className="font-serif text-2xl font-medium text-gray-950">
                        Verify your identity
                    </h1>
                    <p className="text-sm text-gray-500">
                        Enter the six-digit code from your authenticator app to
                        continue.
                    </p>
                </div>

                <div className="space-y-6">
                    {displayedLoading ? (
                        <div className="flex h-13 items-center justify-center text-sm text-gray-500">
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading authenticator...
                        </div>
                    ) : displayedFactors.length === 0 ? (
                        <p className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
                            No verified authenticator factor is available for
                            this session.
                        </p>
                    ) : (
                        <>
                            {displayedFactors.length > 1 && (
                                <select
                                    value={displayedFactorId}
                                    onChange={(event) =>
                                        setSelectedFactorId(event.target.value)
                                    }
                                    className="h-9 w-full rounded-lg border border-transparent bg-gray-100 px-3 text-sm text-gray-900 shadow-none outline-none focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45"
                                >
                                    {displayedFactors.map((factor) => (
                                        <option
                                            key={factor.id}
                                            value={factor.id}
                                        >
                                            {factor.friendly_name ||
                                                "Authenticator app"}
                                        </option>
                                    ))}
                                </select>
                            )}
                            <VerificationCodeInput
                                value={code}
                                onChange={setCode}
                                disabled={verifying}
                                autoFocus={!displayedLoading}
                                canSubmit={canVerify}
                                onSubmit={() => void verify()}
                            />
                        </>
                    )}

                    {error && <p className="text-sm text-red-600">{error}</p>}

                    <div className="flex items-center justify-end gap-2 pt-4">
                        <button
                            type="button"
                            onClick={() => void cancel()}
                            disabled={verifying}
                            className="px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                        >
                            Cancel
                        </button>
                        <PillButtonUI
                            tone="black"
                            size="normal"
                            type="button"
                            onClick={() => void verify()}
                            disabled={!canVerify}
                            loading={verifying}
                        >
                            {verifying ? "Verifying..." : "Verify"}
                        </PillButtonUI>
                    </div>
                </div>
            </div>
        </div>
    );
}

function safeNextPath(value: string | null) {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
        return "/assistant";
    }
    if (value.startsWith("/verify-mfa")) return "/assistant";
    return value;
}

"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { authGlassCardClassName } from "@/app/components/auth/authStyles";
import { SiteLogo } from "@/app/components/site-logo";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";
import { useAuth } from "@/app/contexts/AuthContext";

export default function SignupCheckEmailPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 md:top-8">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={authGlassCardClassName}>
                    {authLoading || isAuthenticated ? (
                        <Loader2 className="mx-auto h-6 w-6 animate-spin text-gray-500" />
                    ) : (
                        <>
                            <h1 className="font-serif text-2xl font-medium text-gray-950">
                                Check your email
                            </h1>
                            <p className="mt-3 text-sm leading-relaxed text-gray-600">
                                We sent a confirmation link to your email
                                address. Confirm your address before logging in.
                            </p>
                            <Link
                                href="/login"
                                className={pillButtonUIClassName({
                                    tone: "black",
                                    size: "normal",
                                    className: "mt-6",
                                })}
                            >
                                Return to login
                            </Link>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { login } from "@/app/lib/authApi";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { cn } from "@/app/lib/utils";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { AuthDivider } from "@/app/components/auth/AuthDivider";
import { SsoAuthButton } from "@/app/components/auth/SsoAuthButton";
import { GoogleAuthButton } from "@/app/components/auth/GoogleAuthButton";
import { FieldLabel } from "@/app/components/ui/form-field";
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";

export default function LoginPage() {
    const t = useTranslations("auth.login");
    const loginErrorMessages: Record<string, string> = {
        invalid_credentials: t("erroCredenciais"),
        email_not_confirmed: t("erroEmailNaoConfirmado"),
    };
    const router = useRouter();
    const {
        isAuthenticated,
        authLoading,
        authError,
        refreshSession,
        retrySession,
    } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            await login(email, password);
            await refreshSession();
            router.push("/onboarding/profile");
        } catch (error: unknown) {
            setError(
                knownErrorCodeMessage(
                    error,
                    loginErrorMessages,
                    t("erroPadrao"),
                ),
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className={cn(authGlassCardClassName, "mb-4")}>
                    <h2 className="mb-6 text-left text-2xl font-medium font-serif text-gray-950">
                        {t("titulo")}
                    </h2>
                    <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <FieldLabel htmlFor="email">
                                {t("labelEmail")}
                            </FieldLabel>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <FieldLabel htmlFor="password">
                                    {t("labelSenha")}
                                </FieldLabel>
                                <Link
                                    href="/forgot-password"
                                    className="text-xs font-medium text-gray-500 transition-colors hover:text-gray-950"
                                >
                                    {t("forgotPassword")}
                                </Link>
                            </div>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        {(error || authError) && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error ?? authError}
                                {!error && authError && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void retrySession().catch(() => {})
                                        }
                                        className="ml-2 underline underline-offset-2"
                                    >
                                        {t("retry")}
                                    </button>
                                )}
                            </div>
                        )}

                        <div className="pt-2">
                            <PillButton
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading}
                                className="w-full"
                            >
                                {loading ? t("botaoEntrando") : t("botaoEntrar")}
                            </PillButton>
                        </div>
                        <AuthDivider />
                        <GoogleAuthButton
                            onError={setError}
                            disabled={loading}
                            onLoadingChange={setLoading}
                        />
                        <SsoAuthButton disabled={loading} />
                    </form>
                </div>
                <div className="text-center text-sm text-gray-500">
                    {t("semConta")}{" "}
                    <Link
                        href="/signup"
                        className="font-medium transition-colors hover:text-gray-950"
                    >
                        {t("cadastre")}
                    </Link>
                </div>
            </div>
        </div>
    );
}

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { signup } from "@/app/lib/authApi";
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
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";
import { MIN_PASSWORD_LENGTH } from "@/app/components/auth/passwordPolicy";
import { AuthDivider } from "@/app/components/auth/AuthDivider";
import { GoogleAuthButton } from "@/app/components/auth/GoogleAuthButton";
import { FieldLabel } from "@/app/components/ui/form-field";

function SignupContent() {
    const t = useTranslations("auth.signup");
    const signupErrorMessages: Record<string, string> = {
        user_already_exists: t("erroEmailExistente"),
        email_exists: t("erroEmailExistente"),
        over_email_send_rate_limit: t("erroMuitosEmails"),
        weak_password: t("erroSenhaFraca"),
    };
    const router = useRouter();
    const searchParams = useSearchParams();
    const { isAuthenticated, authLoading, refreshSession } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const isAccountCreatedPreview =
        process.env.NODE_ENV !== "production" &&
        searchParams.get("preview") === "account-created";

    useEffect(() => {
        if (isAccountCreatedPreview) return;
        if (!authLoading && isAuthenticated && !success) {
            router.replace("/onboarding/profile");
        }
    }, [
        authLoading,
        isAccountCreatedPreview,
        isAuthenticated,
        router,
        success,
    ]);

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        // Validate passwords match
        if (password !== confirmPassword) {
            setError(t("erroSenhaNaoCoincidem"));
            setLoading(false);
            return;
        }

        // Validate password length
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError(t("erroSenhaMinima", { count: MIN_PASSWORD_LENGTH }));
            setLoading(false);
            return;
        }

        try {
            const trimmedEmail = email.trim();
            const result = await signup(
                trimmedEmail,
                password,
                "/onboarding/profile",
            );

            if (!result.requiresEmailConfirmation) {
                await refreshSession();
                setSuccess(true);
                setTimeout(() => {
                    router.push("/onboarding/profile");
                }, 2000);
            } else {
                router.push("/signup/check-email");
            }
        } catch (error: unknown) {
            setError(
                knownErrorCodeMessage(
                    error,
                    signupErrorMessages,
                    t("erroPadrao"),
                ),
            );
        } finally {
            setLoading(false);
        }
    };

    // Success View
    if (success || isAccountCreatedPreview) {
        return (
            <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="lg" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className={authGlassCardClassName}>
                        <h1 className="font-serif text-2xl font-medium text-gray-950">
                            {t("contaCriada")}
                        </h1>
                        <p className="mt-3 text-sm leading-relaxed text-gray-600">
                            {t("redirecionandoConfiguracao")}
                        </p>
                        <PillButton
                            asChild
                            tone="black"
                            size="normal"
                            className="mt-6"
                        >
                            <Link href="/onboarding/profile">
                                {t("continuar")}
                            </Link>
                        </PillButton>
                    </div>
                </div>
            </div>
        );
    }

    // Default Signup Form View
    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-24">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={cn(authGlassCardClassName, "mb-4")}>
                    <h2 className="mb-6 text-left text-2xl font-medium font-serif text-gray-950">
                        {t("titulo")}
                    </h2>

                    <form onSubmit={handleSignup} className="space-y-4">
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
                            <FieldLabel htmlFor="password">
                                {t("labelSenha")}
                            </FieldLabel>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={t("placeholderSenhaMinima", {
                                    count: MIN_PASSWORD_LENGTH,
                                })}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        <div>
                            <FieldLabel htmlFor="confirmPassword">
                                {t("labelConfirmarSenha")}
                            </FieldLabel>
                            <Input
                                id="confirmPassword"
                                type="password"
                                value={confirmPassword}
                                onChange={(e) =>
                                    setConfirmPassword(e.target.value)
                                }
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        {error && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <div className="space-y-3 pt-2">
                            <div className="text-center text-xs text-gray-500">
                                {t("termos")}{" "}
                                <Link
                                    href="https://mikeoss.com/terms"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    {t("termosDeUso")}
                                </Link>{" "}
                                {t("e")}{" "}
                                <Link
                                    href="https://mikeoss.com/privacy"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    {t("politicaPrivacidade")}
                                </Link>
                            </div>
                            <PillButton
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading}
                                className="w-full"
                            >
                                {loading
                                    ? t("botaoCriando")
                                    : t("botaoCadastrar")}
                            </PillButton>
                            <AuthDivider />
                            <GoogleAuthButton
                                onError={setError}
                                disabled={loading}
                                onLoadingChange={setLoading}
                            />
                        </div>
                    </form>
                </div>
                <div className="text-center text-sm text-gray-500">
                    {t("temConta")}{" "}
                    <Link
                        href="/login"
                        className="font-medium transition-colors hover:text-gray-950"
                    >
                        {t("entrar")}
                    </Link>
                </div>
            </div>
        </div>
    );
}

export default function SignupPage() {
    return (
        <Suspense fallback={null}>
            <SignupContent />
        </Suspense>
    );
}

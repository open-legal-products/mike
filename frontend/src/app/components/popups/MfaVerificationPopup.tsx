"use client";

import {
    useEffect,
    useRef,
    useState,
    type ClipboardEvent,
    type KeyboardEvent,
} from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
    challengeAndVerifyMfa,
    getMfaAssurance,
    listMfaFactors,
} from "@/app/lib/authApi";
import { Modal } from "../modals/Modal";

type MfaFactor = {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
};

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

export async function needsMfaVerification() {
    const data = await getMfaAssurance();
    return data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}

interface MfaVerificationPopupProps {
    open: boolean;
    onCancel: () => void;
    onVerified: () => void;
    title?: string;
    message?: string;
}

export function MfaVerificationPopup({
    open,
    onCancel,
    onVerified,
    title,
    message,
}: MfaVerificationPopupProps) {
    const t = useTranslations("popups.mfa");
    const tMfa = useTranslations("auth.verificarMfa");
    const resolvedTitle = title ?? t("titulo");
    const resolvedMessage = message ?? t("mensagem");
    const [factors, setFactors] = useState<MfaFactor[]>([]);
    const [selectedFactorId, setSelectedFactorId] = useState("");
    const [code, setCode] = useState("");
    const [loading, setLoading] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const canVerify =
        !verifying &&
        !loading &&
        !!selectedFactorId &&
        code.trim().length === 6;

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        devLog("[mfa-popup] opened");

        async function loadFactors() {
            setLoading(true);
            setError(null);
            setCode("");
            try {
                const data = await listMfaFactors();
                if (cancelled) return;
                const verified = (data.totp ?? []) as MfaFactor[];
                devLog("[mfa-popup] factors loaded", {
                    totpCount: verified.length,
                    selectedFactorId: verified[0]?.id ?? null,
                });
                setFactors(verified);
                setSelectedFactorId(verified[0]?.id ?? "");
            } catch (listError) {
                if (cancelled) return;
                devLog("[mfa-popup] list factors failed", {
                    error:
                        listError instanceof Error
                            ? listError.message
                            : String(listError),
                });
                setError(tMfa("erroCarregar"));
                setFactors([]);
                setSelectedFactorId("");
            }
            setLoading(false);
        }

        void loadFactors();
        return () => {
            cancelled = true;
        };
    }, [open]);

    async function verify() {
        if (!canVerify) return;

        setVerifying(true);
        setError(null);
        devLog("[mfa-popup] verifying code", { factorId: selectedFactorId });
        try {
            await challengeAndVerifyMfa(selectedFactorId, code.trim());
        } catch (verifyError) {
            setVerifying(false);
            devLog("[mfa-popup] verification failed", {
                error:
                    verifyError instanceof Error
                        ? verifyError.message
                        : String(verifyError),
            });
            setError(tMfa("erroCodigoInvalido"));
            return;
        }

        setVerifying(false);
        devLog("[mfa-popup] verification succeeded");
        setCode("");
        onVerified();
    }

    if (!open) return null;

    return (
        <Modal
            open={open}
            onClose={onCancel}
            breadcrumbs={[resolvedTitle]}
            size="sm"
            className="h-auto min-h-[310px] max-h-[min(92vh,400px)]"
            cancelAction={{
                label: tMfa("cancelar"),
                onClick: onCancel,
                disabled: verifying,
            }}
            primaryAction={{
                label: verifying ? (
                    <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {tMfa("botaoVerificando")}
                    </span>
                ) : (
                    tMfa("botaoVerificar")
                ),
                onClick: () => void verify(),
                disabled: !canVerify,
            }}
        >
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-2 pt-0">
                <p className="text-sm text-gray-500 pb-6">{resolvedMessage}</p>
                {loading ? (
                    <div className="flex h-13 items-center justify-center text-sm text-gray-500">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {tMfa("carregando")}
                    </div>
                ) : factors.length === 0 ? (
                    <p className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
                        {tMfa("semFatorSessao")}
                    </p>
                ) : (
                    <div className="space-y-4">
                        {factors.length > 1 && (
                            <select
                                value={selectedFactorId}
                                onChange={(event) =>
                                    setSelectedFactorId(event.target.value)
                                }
                                className="h-9 w-full rounded-lg bg-gray-100 px-3 text-sm text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-gray-300/45"
                            >
                                {factors.map((factor) => (
                                    <option key={factor.id} value={factor.id}>
                                        {factor.friendly_name ||
                                            tMfa("appAutenticacao")}
                                    </option>
                                ))}
                            </select>
                        )}
                        <VerificationCodeInput
                            value={code}
                            onChange={setCode}
                            disabled={verifying}
                            autoFocus={open && !loading}
                            onSubmit={() => void verify()}
                            canSubmit={canVerify}
                        />
                    </div>
                )}
                {error && <p className="text-xs text-red-600">{error}</p>}
            </div>
        </Modal>
    );
}

export function VerificationCodeInput({
    value,
    onChange,
    disabled,
    autoFocus,
    onSubmit,
    canSubmit,
}: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    autoFocus?: boolean;
    onSubmit?: () => void;
    canSubmit?: boolean;
}) {
    const t = useTranslations("popups.mfa");
    const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
    const digits = Array.from({ length: 6 }, (_, index) => value[index] ?? "");

    useEffect(() => {
        if (!autoFocus || disabled) return;
        const focusTimer = window.setTimeout(() => {
            const firstEmptyIndex = digits.findIndex((digit) => !digit);
            inputsRef.current[
                firstEmptyIndex === -1 ? 0 : firstEmptyIndex
            ]?.focus();
        }, 0);
        return () => window.clearTimeout(focusTimer);
    }, [autoFocus, disabled]);

    function updateDigit(index: number, nextValue: string) {
        const digit = nextValue.replace(/\D/g, "").slice(-1);
        const nextDigits = [...digits];
        nextDigits[index] = digit;
        onChange(nextDigits.join(""));
        if (digit && index < inputsRef.current.length - 1) {
            inputsRef.current[index + 1]?.focus();
        }
    }

    function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
        event.preventDefault();
        const pasted = event.clipboardData
            .getData("text")
            .replace(/\D/g, "")
            .slice(0, 6);
        if (!pasted) return;
        onChange(pasted);
        inputsRef.current[Math.min(pasted.length, 6) - 1]?.focus();
    }

    function handleKeyDown(
        event: KeyboardEvent<HTMLInputElement>,
        index: number,
    ) {
        if (event.key === "Enter") {
            event.preventDefault();
            if (canSubmit) onSubmit?.();
            return;
        }
        if (event.key === "Backspace" && !digits[index] && index > 0) {
            inputsRef.current[index - 1]?.focus();
        }
        if (event.key === "ArrowLeft" && index > 0) {
            event.preventDefault();
            inputsRef.current[index - 1]?.focus();
        }
        if (event.key === "ArrowRight" && index < digits.length - 1) {
            event.preventDefault();
            inputsRef.current[index + 1]?.focus();
        }
    }

    return (
        <div
            className="flex justify-center gap-2"
            role="group"
            aria-label={t("ariaCodigo")}
        >
            {digits.map((digit, index) => (
                <input
                    key={index}
                    ref={(element) => {
                        inputsRef.current[index] = element;
                    }}
                    type="text"
                    inputMode="numeric"
                    autoComplete={index === 0 ? "one-time-code" : "off"}
                    value={digit}
                    disabled={disabled}
                    onChange={(event) => updateDigit(index, event.target.value)}
                    onPaste={handlePaste}
                    onKeyDown={(event) => handleKeyDown(event, index)}
                    className="h-13 w-12 rounded-lg border border-gray-300 bg-gray-50 text-center text-2xl font-medium font-serif text-gray-950 shadow-none outline-none transition-colors focus:border-gray-400 focus:ring-2 focus:ring-gray-300/45 disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label={t("ariaDigito", { numero: index + 1 })}
                    maxLength={1}
                />
            ))}
        </div>
    );
}

"use client";

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { useTranslations } from "next-intl";
import { Copy } from "lucide-react";
import {
  AuthApiError,
  challengeMfa,
  enrollMfa,
  getMfaAssurance,
  listMfaFactors,
  unenrollMfa,
  verifyMfa,
} from "@/app/lib/authApi";
import { PillButton } from "@/app/components/ui/pill-button";
import { ToggleSwitch } from "@/app/components/ui/toggle-switch";
import { PasswordSettingsSection } from "@/app/components/settings/PasswordSettingsSection";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { isMfaRequiredError } from "@/app/lib/mikeApi";
import { Modal } from "@/app/components/modals/Modal";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import {
  knownErrorCodeMessage,
  userFacingApiError,
} from "@/app/lib/userFacingError";

type MfaFactor = {
  id: string;
  friendly_name?: string | null;
  factor_type: string;
  status?: string;
};

type Enrollment = {
  factorId: string;
  challengeId: string;
  qrCode: string;
  secret: string;
};

const isDev = process.env.NODE_ENV !== "production";
const traceMfa = (...args: Parameters<typeof console.info>) => {
  if (isDev) console.info(...args);
};

function summarizeFactors(factors: MfaFactor[]) {
  return factors.map((factor) => ({
    type: factor.factor_type,
    status: factor.status ?? "unknown",
    friendlyName: factor.friendly_name ?? null,
  }));
}

function isDuplicateFriendlyNameError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";
  return message.toLowerCase().includes("a factor with the friendly name");
}

function VerificationCodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("configuracoes.seguranca");
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: 6 }, (_, index) => value[index] ?? "");

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
      aria-label={t("digitosAria")}
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
          className="h-11 w-10 rounded-lg border border-transparent bg-gray-100 text-center text-lg font-medium text-gray-950 shadow-none outline-none transition-colors focus:border-gray-200 focus:ring-2 focus:ring-gray-300/45 disabled:cursor-not-allowed disabled:opacity-45"
          aria-label={t("digitoAria", { index: index + 1 })}
          maxLength={1}
        />
      ))}
    </div>
  );
}

function MfaSettingsSkeleton() {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-5">
      <div className="min-w-0 flex-1 space-y-1">
        <div>
          <div className="h-4 w-36 animate-pulse rounded bg-gray-100" />
        </div>
        <div className="space-y-1.5 pt-1">
          <div className="h-3 w-full max-w-md animate-pulse rounded bg-gray-100" />
          <div className="h-3 w-3/4 max-w-sm animate-pulse rounded bg-gray-100" />
        </div>
      </div>
      <div className="h-9 w-20 shrink-0 animate-pulse rounded-lg bg-gray-100" />
    </div>
  );
}

export default function SecurityPage() {
  const t = useTranslations("configuracoes.seguranca");
  const tComum = useTranslations("common");
  const tMfa = useTranslations("auth.verificarMfa");
  const { profile, updateMfaOnLogin } = useUserProfile();
  const [loading, setLoading] = useState(true);
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [currentLevel, setCurrentLevel] = useState<string | null>(null);
  const [nextLevel, setNextLevel] = useState<string | null>(null);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [setupKeyCopied, setSetupKeyCopied] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingLoginPreference, setSavingLoginPreference] = useState(false);
  const [pendingUnenrollFactorId, setPendingUnenrollFactorId] = useState<
    string | null
  >(null);
  const [pendingLoginPreference, setPendingLoginPreference] = useState<
    boolean | null
  >(null);

  async function refreshMfaState() {
    setLoading(true);
    setStatus(null);
    traceMfa("[security/mfa] refreshing state");
    try {
      const [factorResult, aalResult] = await Promise.all([
        listMfaFactors(),
        getMfaAssurance(),
      ]);
      const verifiedTotp = (factorResult.totp ?? []) as MfaFactor[];
      const allFactors = (factorResult.all ?? []) as MfaFactor[];
      traceMfa("[security/mfa] factors loaded", {
        allCount: allFactors.length,
        verifiedTotpCount: verifiedTotp.length,
        all: summarizeFactors(allFactors),
      });
      setFactors(verifiedTotp);
      traceMfa("[security/mfa] assurance level", {
        currentLevel: aalResult.currentLevel,
        nextLevel: aalResult.nextLevel,
      });
      setCurrentLevel(aalResult.currentLevel);
      setNextLevel(aalResult.nextLevel);
    } catch (error) {
      traceMfa("[security/mfa] state load failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      setStatus(t("erroCarregarMfa"));
      setFactors([]);
      setCurrentLevel(null);
      setNextLevel(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    traceMfa("[security/mfa] page mounted");
    void refreshMfaState();
  }, []);

  useEffect(() => {
    traceMfa("[security/mfa] rendered state", {
      loading,
      verifiedFactorCount: factors.length,
      currentLevel,
      nextLevel,
      hasEnrollment: !!enrollment,
    });
  }, [currentLevel, enrollment, factors.length, loading, nextLevel]);

  async function startEnrollment() {
    setBusy(true);
    setStatus(null);
    try {
      traceMfa("[security/mfa] enrollment requested");

      let data;
      try {
        data = await enrollMfa("Mike");
      } catch (error) {
        if (!isDuplicateFriendlyNameError(error)) throw error;
        traceMfa("[security/mfa] retrying enrollment with unique name", {
          error: error instanceof Error ? error.message : String(error),
        });
        data = await enrollMfa(`Mike ${Date.now()}`);
      }
      traceMfa("[security/mfa] enrollment created", {
        factorId: data.id,
      });

      const challenge = await challengeMfa(data.id);
      traceMfa("[security/mfa] enrollment challenge created", {
        factorId: data.id,
        challengeId: challenge.id,
      });

      setEnrollment({
        factorId: data.id,
        challengeId: challenge.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      });
      setVerificationCode("");
      setSetupKeyCopied(false);
    } catch (error) {
      traceMfa("[security/mfa] setup failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      setStatus(t("erroIniciar"));
    } finally {
      setBusy(false);
    }
  }

  async function closeSetupModal() {
    if (busy) return;
    setSetupModalOpen(false);
    if (enrollment) {
      await cancelEnrollment();
    } else {
      setVerificationCode("");
      setSetupKeyCopied(false);
    }
  }

  async function returnToSetupInstructions() {
    if (busy || !enrollment) return;
    await cancelEnrollment();
  }

  async function verifyEnrollment() {
    if (!enrollment || verificationCode.trim().length !== 6) return;

    setBusy(true);
    setStatus(null);
    try {
      traceMfa("[security/mfa] verifying enrollment", {
        factorId: enrollment.factorId,
        challengeId: enrollment.challengeId,
      });
      await verifyMfa(
        enrollment.factorId,
        enrollment.challengeId,
        verificationCode.trim(),
      );
      traceMfa("[security/mfa] enrollment verified", {
        factorId: enrollment.factorId,
      });

      setEnrollment(null);
      setSetupModalOpen(false);
      setVerificationCode("");
      setSetupKeyCopied(false);
      setStatus(t("mfaAtivado"));
      await refreshMfaState();
    } catch (error) {
      setStatus(
        knownErrorCodeMessage(
          error,
          {
            mfa_verification_failed: tMfa("erroCodigoInvalido"),
            otp_expired: tMfa("erroCodigoInvalido"),
          },
          t("erroVerificarCodigo"),
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancelEnrollment() {
    const factorId = enrollment?.factorId;
    setEnrollment(null);
    setVerificationCode("");
    setSetupKeyCopied(false);
    if (factorId) {
      await unenrollMfa(factorId).catch(() => null);
    }
    await refreshMfaState();
  }

  async function copySetupKey() {
    if (!enrollment?.secret) return;
    await navigator.clipboard.writeText(enrollment.secret);
    setSetupKeyCopied(true);
    window.setTimeout(() => setSetupKeyCopied(false), 1600);
  }

  async function requestUnenroll(factorId: string) {
    setStatus(null);
    let data;
    try {
      data = await getMfaAssurance();
    } catch (error) {
      traceMfa("[security/mfa] state verification failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      setStatus(t("erroVerificarEstado"));
      return;
    }

    if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
      setPendingUnenrollFactorId(factorId);
      return;
    }

    await unenrollFactor(factorId);
  }

  async function unenrollFactor(factorId: string) {
    setBusy(true);
    setStatus(null);
    try {
      await unenrollMfa(factorId);
    } catch (error) {
      setBusy(false);
      if (
        (error instanceof Error &&
          error.message.toLowerCase().includes("aal")) ||
        (error instanceof AuthApiError && error.code === "insufficient_aal")
      ) {
        setPendingUnenrollFactorId(factorId);
        return;
      }
      traceMfa("[security/mfa] disable failed", {
        errorType: error instanceof Error ? error.name : typeof error,
      });
      setStatus(t("erroDesativar"));
      return;
    }
    setBusy(false);

    setStatus(t("mfaDesativado"));
    if (profile?.mfaOnLogin) {
      void updateMfaOnLogin(false);
    }
    await refreshMfaState();
  }

  async function handleLoginPreferenceToggle() {
    if (!hasVerifiedFactor || savingLoginPreference) return;
    const enabled = !(profile?.mfaOnLogin === true);
    setSavingLoginPreference(true);
    setStatus(null);
    try {
      if (await needsMfaVerification()) {
        setPendingLoginPreference(enabled);
        return;
      }
      await saveLoginPreference(enabled);
    } catch (error) {
      setStatus(
        userFacingApiError(error, t("erroPreferenciaLogin")),
      );
    } finally {
      setSavingLoginPreference(false);
    }
  }

  async function saveLoginPreference(enabled: boolean) {
    setSavingLoginPreference(true);
    setStatus(null);
    try {
      const success = await updateMfaOnLogin(enabled);
      if (!success) {
        setStatus(t("erroPreferenciaLogin"));
      }
    } catch (error) {
      if (isMfaRequiredError(error)) {
        setPendingLoginPreference(enabled);
      } else {
        setStatus(
          userFacingApiError(error, t("erroPreferenciaLogin")),
        );
      }
    } finally {
      setSavingLoginPreference(false);
    }
  }

  const hasVerifiedFactor = factors.length > 0;
  const sessionVerified = currentLevel === "aal2";
  const loginMfaEnabled = profile?.mfaOnLogin === true;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>{t("titulo")}</SettingsHeading>
        <SettingsCard>
          {loading ? (
            <MfaSettingsSkeleton />
          ) : (
            <>
              <SettingsRow>
                <div className="min-w-0 space-y-1">
                  <SettingsLabel>{t("metodoVerificacao")}</SettingsLabel>
                  <SettingsDescription>
                    {hasVerifiedFactor
                      ? sessionVerified
                        ? t("estadoVerificado")
                        : t("estadoNaoVerificado")
                      : t("estadoSemFator")}
                  </SettingsDescription>
                </div>
                {hasVerifiedFactor ? (
                  <span className="shrink-0 text-xs font-medium text-green-700">
                    {t("ativado")}
                  </span>
                ) : !enrollment ? (
                  <PillButton
                    tone="blue"
                    size="sm"
                    onClick={() => setSetupModalOpen(true)}
                    disabled={busy}
                    loading={busy}
                    className="shrink-0"
                  >
                    {busy ? t("iniciando") : t("configurar")}
                  </PillButton>
                ) : null}
              </SettingsRow>

              {hasVerifiedFactor && (
                <>
                  <SettingsRow>
                    <div className="space-y-1">
                      <SettingsLabel>{t("verificacaoLogin")}</SettingsLabel>
                      <SettingsDescription>
                        {t("descricaoVerificacaoLogin")}
                      </SettingsDescription>
                    </div>
                    <ToggleSwitch
                      checked={loginMfaEnabled}
                      disabled={savingLoginPreference}
                      aria-busy={savingLoginPreference}
                      aria-label={t("verificacaoLogin")}
                      onCheckedChange={() => void handleLoginPreferenceToggle()}
                    />
                  </SettingsRow>
                  <div className="flex justify-end px-4 pb-4 pt-1">
                    <button
                      type="button"
                      onClick={() => void requestUnenroll(factors[0]?.id)}
                      disabled={busy || !factors[0]?.id}
                      className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                    >
                      {t("removerAutenticador")}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {status && (
            <p className="px-4 py-3 text-xs text-gray-500">{status}</p>
          )}
        </SettingsCard>
      </section>
      <PasswordSettingsSection />
      <Modal
        open={setupModalOpen}
        onClose={() => void closeSetupModal()}
        breadcrumbs={[t("trilhaSeguranca"), t("trilhaConfigurar")]}
        cancelAction={{
          label: enrollment ? tComum("back") : tComum("cancel"),
          onClick: enrollment
            ? () => void returnToSetupInstructions()
            : () => void closeSetupModal(),
          disabled: busy,
        }}
        primaryAction={
          enrollment
            ? {
                label: busy ? tMfa("botaoVerificando") : tMfa("botaoVerificar"),
                onClick: () => void verifyEnrollment(),
                disabled: busy || verificationCode.trim().length !== 6,
              }
            : {
                label: busy ? t("iniciando") : t("continuar"),
                onClick: () => void startEnrollment(),
                disabled: busy,
              }
        }
      >
        <div
          className={
            enrollment
              ? "min-h-0 flex-1 space-y-3 overflow-y-auto pt-2"
              : "min-h-0 flex-1 space-y-5 overflow-y-auto pt-3"
          }
        >
          {!enrollment ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                {t("etapa1")}
              </p>
              <div className="space-y-1">
                <p className="text-sm font-medium text-gray-700">
                  {t("antesDeComecar")}
                </p>
                <p className="text-sm text-gray-500">
                  {t("descricaoAntes")}
                </p>
              </div>
              <ol className="list-decimal space-y-1 pl-4 text-sm text-gray-500">
                <li>{t("passo1")}</li>
                <li>{t("passo2")}</li>
              </ol>
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                {t("etapa2")}
              </p>
              <div className="space-y-1">
                <p className="text-sm font-medium text-gray-700">
                  {t("escanearCodigo")}
                </p>
                <p className="text-sm text-gray-500">
                  {t("descricaoEscanear")}
                </p>
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-gray-500">
                    {t("chaveConfiguracao")}
                  </p>
                  <button
                    type="button"
                    onClick={() => void copySetupKey()}
                    className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition-colors hover:text-gray-950"
                  >
                    <Copy className="h-3 w-3" />
                    {setupKeyCopied ? t("copiado") : t("copiar")}
                  </button>
                </div>
                <p className="break-all text-xs text-gray-700">
                  {enrollment.secret}
                </p>
              </div>
              <div className="flex justify-center">
                <div className="flex h-48 w-48 items-center justify-center rounded-xl bg-white p-2">
                  <img
                    src={enrollment.qrCode}
                    alt={t("altQrCode")}
                    className="h-full w-full"
                  />
                </div>
              </div>
              <div className="min-w-0 space-y-3">
                <VerificationCodeInput
                  value={verificationCode}
                  onChange={setVerificationCode}
                  disabled={busy}
                />
              </div>
            </>
          )}
        </div>
      </Modal>
      <MfaVerificationPopup
        open={!!pendingUnenrollFactorId}
        onCancel={() => setPendingUnenrollFactorId(null)}
        onVerified={() => {
          const factorId = pendingUnenrollFactorId;
          setPendingUnenrollFactorId(null);
          if (factorId) void unenrollFactor(factorId);
        }}
      />
      <MfaVerificationPopup
        open={pendingLoginPreference !== null}
        onCancel={() => setPendingLoginPreference(null)}
        onVerified={() => {
          const enabled = pendingLoginPreference;
          setPendingLoginPreference(null);
          if (enabled !== null) void saveLoginPreference(enabled);
        }}
        title={t("tituloMfaPopup")}
        message={t("mensagemMfaPopup")}
      />
    </div>
  );
}

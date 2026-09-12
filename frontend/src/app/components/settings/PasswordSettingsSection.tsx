"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { authInputClassName } from "@/app/components/auth/authStyles";
import { MIN_PASSWORD_LENGTH } from "@/app/components/auth/passwordPolicy";
import { Modal } from "@/app/components/modals/Modal";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { requestPasswordReset } from "@/app/lib/authApi";
import { SettingsCard } from "./SettingsCard";
import { SettingsHeading } from "./SettingsHeading";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";
import { FieldLabel } from "@/app/components/ui/form-field";

export function PasswordSettingsSection() {
  const t = useTranslations("configuracoes.senha");
  const tComum = useTranslations("common");
  const { user, setPassword } = useAuth();
  const { profile, syncPasswordSet } = useUserProfile();
  const [setPasswordOpen, setSetPasswordOpen] = useState(false);
  const [password, setPasswordValue] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordSetError, setPasswordSetError] = useState<string | null>(null);
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
  const [passwordResetSending, setPasswordResetSending] = useState(false);

  const needsInitialPassword =
    user?.createdWithGoogle === true && profile?.passwordSet !== true;

  async function addPassword() {
    setPasswordSetError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordSetError(t("erroMinimoCaracteres", { count: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirmPassword) {
      setPasswordSetError(t("senhasDiferentes"));
      return;
    }

    setPasswordSaving(true);
    try {
      await setPassword(password);
      const synced = await syncPasswordSet();
      if (!synced) {
        throw new Error(t("erroSincronizarStatus"));
      }
      setPasswordValue("");
      setConfirmPassword("");
      setSetPasswordOpen(false);
      setPasswordStatus(t("senhaAdicionada"));
    } catch (error) {
      setPasswordSetError(
        error instanceof Error ? error.message : t("erroDefinirSenha"),
      );
    } finally {
      setPasswordSaving(false);
    }
  }

  async function sendPasswordReset() {
    if (!user?.email || passwordResetSending) return;
    setPasswordResetSending(true);
    setPasswordStatus(null);
    try {
      await requestPasswordReset(user.email);
      setPasswordStatus(t("instrucoesEnviadas", { email: user.email }));
    } catch {
      setPasswordStatus(t("erroEnviarRedefinicao"));
    } finally {
      setPasswordResetSending(false);
    }
  }

  function closeSetPassword() {
    if (passwordSaving) return;
    setSetPasswordOpen(false);
    setPasswordSetError(null);
    setPasswordValue("");
    setConfirmPassword("");
  }

  return (
    <section className="space-y-3">
      <SettingsHeading>{t("titulo")}</SettingsHeading>
      <SettingsCard>
        <SettingsRow>
          <div className="min-w-0 space-y-1">
            <SettingsLabel>
              {needsInitialPassword ? t("definirSenha") : t("redefinirSenha")}
            </SettingsLabel>
            <SettingsDescription>
              {needsInitialPassword
                ? t("descricaoDefinirSenha")
                : t("descricaoRedefinir", { email: user?.email ?? "" })}
            </SettingsDescription>
            {passwordStatus && (
              <p className="text-xs text-gray-500">{passwordStatus}</p>
            )}
          </div>
          <PillButton
            tone="black"
            size="sm"
            onClick={() =>
              needsInitialPassword
                ? setSetPasswordOpen(true)
                : void sendPasswordReset()
            }
            disabled={passwordResetSending || !user?.email || passwordSaving}
            className="shrink-0"
          >
            {needsInitialPassword
              ? t("definirSenha")
              : passwordResetSending
                ? t("enviando")
                : t("enviarEmailRedefinicao")}
          </PillButton>
        </SettingsRow>
      </SettingsCard>

      <Modal
        open={setPasswordOpen}
        onClose={closeSetPassword}
        breadcrumbs={[t("trilhaSeguranca"), t("definirSenha")]}
        size="sm"
        className="h-auto"
        cancelAction={{
          label: tComum("cancel"),
          onClick: closeSetPassword,
          disabled: passwordSaving,
        }}
        primaryAction={{
          label: passwordSaving ? t("definindo") : t("definirSenha"),
          onClick: () => void addPassword(),
          disabled: passwordSaving || !password || !confirmPassword,
        }}
      >
        <div className="space-y-4 pb-5">
          <p className="text-sm text-gray-500">
            {t("useMinimoCaracteres", { count: MIN_PASSWORD_LENGTH })}
          </p>
          <div>
            <FieldLabel htmlFor="new-account-password">
              {t("labelSenha")}
            </FieldLabel>
            <Input
              id="new-account-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPasswordValue(event.target.value)}
              className={`w-full ${authInputClassName}`}
            />
          </div>
          <div>
            <FieldLabel htmlFor="confirm-account-password">
              {t("labelConfirmarSenha")}
            </FieldLabel>
            <Input
              id="confirm-account-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className={`w-full ${authInputClassName}`}
            />
          </div>
          {passwordSetError && (
            <p className="text-sm text-red-600" role="alert">
              {passwordSetError}
            </p>
          )}
        </div>
      </Modal>
    </section>
  );
}

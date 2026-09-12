"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff } from "lucide-react";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";
import { isMfaRequiredError } from "@/app/lib/mikeApi";
import { settingsGlassIconButtonClassName } from "@/app/(pages)/settings/settingsStyles";

export function ApiKeyField({
  label,
  description,
  placeholder,
  hasSavedKey,
  onSave,
  onRemove,
}: {
  label: string;
  description?: string;
  placeholder: string;
  hasSavedKey: boolean;
  onSave: (value: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const t = useTranslations("configuracoes.chaveApi");
  const tModelos = useTranslations("pages.modelos");
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingMfaAction, setPendingMfaAction] = useState<
    "save" | "remove" | null
  >(null);

  useEffect(() => {
    setValue("");
  }, [hasSavedKey]);

  const dirty = value.trim().length > 0;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction("save");
        return;
      }
      const ok = await onSave(value);
      if (ok) {
        setValue("");
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        alert(t("erroSalvar", { label }));
      }
    } catch (error) {
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("save");
      } else {
        alert(t("erroSalvar", { label }));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    setIsSaving(true);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction("remove");
        return;
      }
      const ok = await onRemove();
      if (!ok) alert(t("erroRemover", { label }));
    } catch (error) {
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("remove");
      } else {
        alert(t("erroRemover", { label }));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleMfaVerified = async () => {
    const action = pendingMfaAction;
    setPendingMfaAction(null);
    if (action === "save") {
      await handleSave();
    } else if (action === "remove") {
      await handleRemove();
    }
  };

  return (
    <>
      <SettingsRow layout="stacked">
        <div className={description ? "space-y-1" : undefined}>
          <SettingsLabel>{label}</SettingsLabel>
          {description && (
            <SettingsDescription>{description}</SettingsDescription>
          )}
        </div>
        <div className="space-y-2">
          <div className="relative flex-1">
            <SettingsTextInput
              aria-label={label}
              type={reveal ? "text" : "password"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                hasSavedKey ? tModelos("placeholderOculta") : placeholder
              }
              className="pr-10"
              autoComplete="off"
              spellCheck={false}
            />
            {dirty && (
              <button
                type="button"
                onClick={() => setReveal((current) => !current)}
                className={`absolute inset-y-1 right-1.5 flex items-center ${settingsGlassIconButtonClassName}`}
                aria-label={
                  reveal ? tModelos("ocultarChave") : tModelos("mostrarChave")
                }
              >
                {reveal ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || !dirty || saved}
              className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
            >
              {isSaving
                ? tModelos("salvando")
                : saved
                  ? tModelos("salvo")
                  : tModelos("salvar")}
            </button>
            {hasSavedKey && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={isSaving}
                className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
              >
                {tModelos("remover")}
              </button>
            )}
          </div>
        </div>
      </SettingsRow>
      <MfaVerificationPopup
        open={!!pendingMfaAction}
        onCancel={() => setPendingMfaAction(null)}
        onVerified={() => void handleMfaVerified()}
      />
    </>
  );
}

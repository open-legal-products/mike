"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";
import { MikeApiError, isMfaRequiredError } from "@/app/lib/mikeApi";
import { settingsGlassIconButtonClassName } from "@/app/(pages)/settings/settingsStyles";

// The backend never returns saved keys, so the mask is a fixed-length stand-in.
const SAVED_KEY_MASK = "x".repeat(24);

/**
 * A non-secret value a key is only usable with (an AWS region, an Azure
 * resource). It is saved together with a new key, and can be changed on its
 * own once a key is saved.
 */
export type ApiKeyFieldSetting = {
  label: string;
  placeholder: string;
  /** The value saved with the user's own key, or null when there is none. */
  savedValue: string | null;
  /** Canonical form of a typed value, or null when it is not valid. */
  normalize: (value: string) => string | null;
  invalidMessage: string;
};

type ApiKeyFieldAction = {
  label: string;
  onClick: () => Promise<void>;
  disabled: boolean;
};

export function ApiKeyField({
  label,
  variant = "settings",
  description,
  hasSavedKey,
  keyLabel = "API key",
  validateKey,
  setting,
  onSave,
  onRemove,
  render,
}: {
  label: string;
  variant?: "settings" | "modal";
  description?: string;
  hasSavedKey: boolean;
  /** What the modal calls the secret, when it is not a plain API key. */
  keyLabel?: string;
  /** Why a typed key cannot be saved, or null when it can. */
  validateKey?: (value: string) => string | null;
  setting?: ApiKeyFieldSetting;
  /** Called with the typed key ("" when only the setting changed) and,
   *  for fields with a setting, its normalized value. */
  onSave: (value: string, settingValue?: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  /** Place the fields and actions separately, such as in a modal footer. */
  render?: (
    fields: ReactNode,
    saveAction: ApiKeyFieldAction,
    removeAction: ApiKeyFieldAction | undefined,
  ) => ReactNode;
}) {
  const settingInputId = useId();
  const settingErrorId = useId();
  const keyErrorId = useId();
  const Input = variant === "modal" ? FormTextInput : SettingsTextInput;
  const Container = variant === "modal" ? "div" : SettingsRow;
  const savedSettingValue = setting?.savedValue ?? "";
  const [value, setValue] = useState("");
  const [settingValue, setSettingValue] = useState(savedSettingValue);
  const [settingError, setSettingError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [pendingMfaAction, setPendingMfaAction] = useState<
    "save" | "remove" | null
  >(null);

  useEffect(() => {
    setValue("");
  }, [hasSavedKey]);

  useEffect(() => {
    setSettingValue(savedSettingValue);
    setSettingError(null);
  }, [savedSettingValue]);

  const keyDirty = value.trim().length > 0;
  const settingDirty =
    !!setting && settingValue.trim() !== savedSettingValue;
  // A setting alone can only be saved onto a key that already exists.
  const dirty = keyDirty || (hasSavedKey && settingDirty);
  const showMask = hasSavedKey && !isEditing && !keyDirty;

  const handleSave = async () => {
    const invalidKey = keyDirty ? (validateKey?.(value) ?? null) : null;
    if (invalidKey) {
      setKeyError(invalidKey);
      return;
    }
    let normalizedSetting: string | undefined;
    if (setting) {
      const normalized = setting.normalize(settingValue);
      if (!normalized) {
        setSettingError(setting.invalidMessage);
        return;
      }
      normalizedSetting = normalized;
    }
    setSettingError(null);
    setIsSaving(true);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction("save");
        return;
      }
      const ok = setting
        ? await onSave(value, normalizedSetting)
        : await onSave(value);
      if (ok) {
        setValue("");
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setWarningMessage(`Failed to save ${label}. Please try again.`);
      }
    } catch (error) {
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("save");
      } else if (error instanceof MikeApiError && error.status === 400) {
        // The backend's validation message says what to correct.
        setWarningMessage(error.message);
      } else {
        setWarningMessage(`Failed to save ${label}. Please try again.`);
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
      if (!ok) {
        setWarningMessage(`Failed to remove ${label}. Please try again.`);
      }
    } catch (error) {
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("remove");
      } else {
        setWarningMessage(`Failed to remove ${label}. Please try again.`);
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

  const saveAction = {
    label: isSaving ? "Saving..." : saved ? "Saved" : "Save",
    onClick: handleSave,
    disabled: isSaving || !dirty || saved,
  };
  const removeAction = hasSavedKey ? {
    label: "Remove",
    onClick: handleRemove,
    disabled: isSaving,
  } : undefined;

  const fields = (
    <Container
      {...(variant === "modal"
        ? { className: "space-y-3" }
        : { layout: "stacked" as const })}
    >
      {variant !== "modal" && (
        <div className={description ? "space-y-1" : undefined}>
          <SettingsLabel>{label}</SettingsLabel>
          {description && (
            <SettingsDescription>{description}</SettingsDescription>
          )}
        </div>
      )}
      <div className={variant === "modal" ? "space-y-4" : "space-y-2"}>
        <div>
          {variant === "modal" && (
            <FieldLabel htmlFor={`${settingInputId}-key`}>{keyLabel}</FieldLabel>
          )}
          <div className="relative flex-1">
            <Input
              id={`${settingInputId}-key`}
              aria-label={label}
              type={reveal && !showMask ? "text" : "password"}
              value={showMask ? SAVED_KEY_MASK : value}
              readOnly={showMask}
              onFocus={() => setIsEditing(true)}
              onBlur={() => setIsEditing(false)}
              onChange={(event) => {
                setValue(event.target.value);
                setKeyError(null);
              }}
              aria-invalid={keyError ? true : undefined}
              aria-describedby={keyError ? keyErrorId : undefined}
              className="pr-10"
              autoComplete="off"
              spellCheck={false}
            />
            {keyDirty && (
              <button
                type="button"
                onClick={() => setReveal((current) => !current)}
                className={`absolute inset-y-1 right-1.5 flex items-center ${settingsGlassIconButtonClassName}`}
                aria-label={reveal ? "Hide key" : "Show key"}
              >
                {reveal ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            )}
          </div>
          {keyError && (
            <p id={keyErrorId} className="mt-1 text-xs text-red-600">
              {keyError}
            </p>
          )}
        </div>
        {setting && (
          <div className="space-y-1">
            {variant === "modal" ? (
              <FieldLabel htmlFor={settingInputId}>{setting.label}</FieldLabel>
            ) : (
              <label htmlFor={settingInputId} className="block text-sm text-gray-500">
                {setting.label}
              </label>
            )}
            <Input
              id={settingInputId}
              type="text"
              value={settingValue}
              onChange={(event) => {
                setSettingValue(event.target.value);
                setSettingError(null);
              }}
              placeholder={setting.placeholder}
              aria-invalid={settingError ? true : undefined}
              aria-describedby={settingError ? settingErrorId : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            {settingError && (
              <p id={settingErrorId} className="text-xs text-red-600">
                {settingError}
              </p>
            )}
          </div>
        )}
        {!render && (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={saveAction.onClick}
              disabled={saveAction.disabled}
              className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
            >
              {saveAction.label}
            </button>
            {removeAction && (
              <button
                type="button"
                onClick={removeAction.onClick}
                disabled={removeAction.disabled}
                className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
              >
                {removeAction.label}
              </button>
            )}
          </div>
        )}
      </div>
    </Container>
  );

  return (
    <>
      {render ? render(fields, saveAction, removeAction) : fields}
      <MfaVerificationPopup
        open={!!pendingMfaAction}
        onCancel={() => setPendingMfaAction(null)}
        onVerified={() => void handleMfaVerified()}
      />
      <WarningPopup
        open={!!warningMessage}
        title="API key update failed"
        message={warningMessage}
        onClose={() => setWarningMessage(null)}
      />
    </>
  );
}

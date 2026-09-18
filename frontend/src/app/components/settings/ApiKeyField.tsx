"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";
import { isMfaRequiredError } from "@/app/lib/mikeApi";
import { settingsGlassIconButtonClassName } from "@/app/(pages)/settings/settingsStyles";

// The backend never returns saved keys, so the mask is a fixed-length stand-in.
const SAVED_KEY_MASK = "x".repeat(24);

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
  const [value, setValue] = useState("");
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

  const dirty = value.trim().length > 0;
  const showMask = hasSavedKey && !isEditing && !dirty;

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
        setWarningMessage(`Failed to save ${label}. Please try again.`);
      }
    } catch (error) {
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("save");
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
              type={reveal && !showMask ? "text" : "password"}
              value={showMask ? SAVED_KEY_MASK : value}
              readOnly={showMask}
              onFocus={() => setIsEditing(true)}
              onBlur={() => setIsEditing(false)}
              onChange={(event) => setValue(event.target.value)}
              placeholder={hasSavedKey ? "Enter a new key to replace" : placeholder}
              className="pr-10"
              autoComplete="off"
              spellCheck={false}
            />
            {dirty && (
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
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || !dirty || saved}
              className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
            >
              {isSaving ? "Saving..." : saved ? "Saved" : "Save"}
            </button>
            {hasSavedKey && (
              <button
                type="button"
                onClick={handleRemove}
                disabled={isSaving}
                className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
              >
                Remove
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
      <WarningPopup
        open={!!warningMessage}
        title="API key update failed"
        message={warningMessage}
        onClose={() => setWarningMessage(null)}
      />
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";
import { isMfaRequiredError } from "@/app/lib/mikeApi";
import {
  UserVisibleError,
  notifyError,
  notifyInfo,
  notifySuccess,
} from "@/app/lib/userFacingError";
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
  const [pendingMfaAction, setPendingMfaAction] = useState<
    "save" | "remove" | null
  >(null);

  // The field is cleared on success and whenever the saved-key state
  // changes, and the user may well correct a rejected key before reaching
  // for the toast. A Retry therefore reads the box as it is NOW instead of
  // resending the value the failed attempt closed over.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    setValue("");
  }, [hasSavedKey]);

  const dirty = value.trim().length > 0;
  const showMask = hasSavedKey && !isEditing && !dirty;

  /**
   * Re-run a save only while the box still holds the key that failed.
   * Anything else — a corrected key, a cleared field — would silently store
   * the wrong secret, so say what happened and leave the input alone.
   */
  const retrySave = (attempted: string) => {
    if (valueRef.current === attempted) {
      void handleSave();
      return;
    }
    notifyInfo(
      valueRef.current.trim().length > 0
        ? `Your ${label} has changed since that attempt. Press Save to store the key now in the field.`
        : `The ${label} field is empty, so there is nothing to retry. Enter the key again and press Save.`,
      "Nothing was sent",
    );
  };

  const handleSave = async () => {
    const attempted = valueRef.current;
    setIsSaving(true);
    try {
      if (await needsMfaVerification()) {
        setPendingMfaAction("save");
        return;
      }
      const ok = await onSave(attempted);
      if (ok) {
        setValue("");
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        // The caller reports failure as `false`, with no error to classify.
        notifyError(
          new UserVisibleError(
            `Mike couldn't save your ${label}. The key was not changed.`,
            { retryable: true },
          ),
          {
            action: `save your ${label}`,
            onRetry: () => retrySave(attempted),
          },
        );
      }
    } catch (error) {
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("save");
      } else {
        notifyError(error, {
          action: `save your ${label}`,
          onRetry: () => retrySave(attempted),
        });
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
      if (ok) {
        notifySuccess(`${label} removed.`);
      } else {
        notifyError(
          new UserVisibleError(
            `Mike couldn't remove your ${label}. The key is still saved.`,
            { retryable: true },
          ),
          {
            action: `remove your ${label}`,
            onRetry: () => void handleRemove(),
          },
        );
      }
    } catch (error) {
      if (isMfaRequiredError(error)) {
        setPendingMfaAction("remove");
      } else {
        notifyError(error, {
          action: `remove your ${label}`,
          onRetry: () => void handleRemove(),
        });
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
    </>
  );
}

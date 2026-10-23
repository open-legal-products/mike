"use client";

import { useCallback, useState } from "react";
import {
  createGoogleDrivePickerSession,
  isMfaRequiredError,
} from "@/app/lib/mikeApi";
import { openGoogleDrivePicker } from "@/app/lib/googlePicker";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { APP_NAME } from "@/shared/lib/branding";

/**
 * "Add files from Google Drive": fetch a short-lived token, open Google's
 * Picker, and describe the outcome in one plain sentence. Picking is itself
 * the grant, so there is nothing to save afterwards.
 *
 * An MFA challenge is rethrown so the page's step-up flow can retry the
 * action; every other failure becomes the status message.
 */
export function useGoogleDrivePicker() {
  const [message, setMessage] = useState<string | null>(null);

  const addFiles = useCallback(async () => {
    setMessage(null);
    try {
      const picked = await openGoogleDrivePicker(
        await createGoogleDrivePickerSession(),
      );
      setMessage(
        picked.length
          ? `Added ${picked.length} ${picked.length === 1 ? "file" : "files"}. ${APP_NAME} can now search and read them.`
          : "No files added.",
      );
    } catch (error) {
      if (isMfaRequiredError(error)) throw error;
      setMessage(
        userFacingApiError(
          error,
          "Google Drive could not be opened. Try again.",
        ),
      );
    }
  }, []);

  return { addFiles, message };
}

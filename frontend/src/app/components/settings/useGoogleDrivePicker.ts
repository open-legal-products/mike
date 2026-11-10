"use client";

import { useCallback, useState } from "react";
import {
  createGoogleDrivePickerSession,
  isMfaRequiredError,
} from "@/app/lib/mikeApi";
import { openGoogleDrivePicker } from "@/app/lib/googlePicker";
import { userFacingApiError } from "@/app/lib/userFacingError";

/**
 * "Add files from Google Drive": fetch a short-lived token, open Google's
 * Picker, and describe the outcome in one plain sentence. Picking is itself
 * the grant, so there is nothing to save afterwards.
 *
 * `workspace` is the workspace whose Drive connection is used ("personal"
 * or an organization id): the one the files are being added for.
 *
 * An MFA challenge is rethrown so the page's step-up flow can retry the
 * action; every other failure becomes the status message.
 */
export function useGoogleDrivePicker(workspace?: string) {
  const [message, setMessage] = useState<string | null>(null);

  const addFiles = useCallback(async () => {
    setMessage(null);
    try {
      const picked = await openGoogleDrivePicker(
        await createGoogleDrivePickerSession(workspace),
      );
      setMessage(
        picked.length
          ? `Added ${picked.length} ${picked.length === 1 ? "file" : "files"}. Mike can now search and read them.`
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
  }, [workspace]);

  return { addFiles, message };
}

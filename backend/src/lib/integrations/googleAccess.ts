// What a user may do with each Google service, from their feature flags.
//
// Google verifies OAuth scopes one bundle at a time, and its reviewers insist
// that the consent screen, the Cloud Console and the running code request
// exactly the same scopes. The flags let a hosted deployment offer each
// bundle only to the people it is verified (or being demonstrated) for:
// Drive is one flag (drive.file serves reads and writes); Gmail and Calendar
// each have a read flag and a write flag, and the write flag counts only
// when the read flag is on, because Mike cannot request a write scope
// without the reads it builds on.
//
// The code default of every flag honours GOOGLE_WORKSPACE_DISABLED_PROVIDERS
// (googleAvailability.ts), so a deployment that never opens the admin panel
// behaves exactly as before.

import type { Db } from "../supabase";
import { resolveFeatureFlags } from "../featureFlags";
import type { GoogleService } from "./googleAvailability";

export type GoogleServiceAccess = {
  /** The service may be connected and its read tools offered. */
  read: boolean;
  /** Its write scope may be requested and its write tools offered. */
  write: boolean;
};

export type GoogleAccessMap = Record<GoogleService, GoogleServiceAccess>;

export async function googleAccessMap(
  db: Db,
  userId: string,
): Promise<GoogleAccessMap> {
  const flags = await resolveFeatureFlags(db, userId);
  const drive = flags["google-drive"].enabled;
  const gmailRead = flags["gmail-read"].enabled;
  const calendarRead = flags["google-calendar-read"].enabled;
  return {
    "google-drive": { read: drive, write: drive },
    gmail: { read: gmailRead, write: gmailRead && flags["gmail-write"].enabled },
    "google-calendar": {
      read: calendarRead,
      write: calendarRead && flags["google-calendar-write"].enabled,
    },
  };
}

export async function googleServiceAccess(
  db: Db,
  userId: string,
  service: GoogleService,
): Promise<GoogleServiceAccess> {
  return (await googleAccessMap(db, userId))[service];
}

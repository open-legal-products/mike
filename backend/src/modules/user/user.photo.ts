import type { Db } from "../../lib/supabase";
import { parseProfileImageDataUrl } from "../../lib/profileImage";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { ensureProfileRow } from "./user.profile.load";

/** Only the authenticated caller's ID is accepted from the HTTP layer. */
export async function setUserProfilePhoto(
    db: Db,
    userId: string,
    value: unknown,
): Promise<ServiceResult<{ profilePhoto: string | null }>> {
    let photo: string | null = null;
    if (value !== null) {
        const parsed = parseProfileImageDataUrl(value, "profile photo");
        if (!parsed.ok) return failure("validation", parsed.detail);
        photo = `data:${parsed.contentType};base64,${parsed.base64}`;
    }
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return internalFailure(ensureError);
    const { error } = await db.from("user_profiles")
        .update({ profile_photo: photo, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
    if (error) return internalFailure(error);
    return ok({ profilePhoto: photo });
}

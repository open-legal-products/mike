import type { Db } from "./supabase";
import { safeError } from "./safeError";

export type ProfileUserInfo = {
    id: string;
    email: string;
    display_name: string | null;
    profile_photo?: string | null;
};

export function normalizeEmail(value: unknown) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeDisplayName(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function profileAttributionName(
    profile: { display_name?: unknown; email?: unknown } | null | undefined,
    fallback: string,
) {
    return (
        normalizeDisplayName(profile?.display_name) ||
        normalizeEmail(profile?.email) ||
        fallback
    );
}

/**
 * Indexes normalized profile identities by email and user ID.
 * Only explicit, caller-authorized roster identities include photos; legacy unscoped reads return names alone.
 */
export async function loadProfileUsersByEmail(
    db: Db,
    people?: { userIds: string[]; emails: string[] },
) {
    // Photos are loaded only for an authorized roster's explicit identities.
    // Legacy callers that need names alone retain the smaller projection.
    const results = people
        ? await Promise.all([
            people.userIds.length ? db.from("user_profiles")
                .select("user_id, email, display_name, profile_photo")
                .in("user_id", [...new Set(people.userIds)])
                : Promise.resolve({ data: [], error: null }),
            people.emails.length ? db.from("user_profiles")
                .select("user_id, email, display_name, profile_photo")
                .in("email", [...new Set(people.emails.map(normalizeEmail))])
                : Promise.resolve({ data: [], error: null }),
        ])
        : [await db.from("user_profiles").select("user_id, email, display_name")
            .not("email", "is", null)];
    for (const result of results) if (result.error) throw result.error;
    const data = results.flatMap((result) => result.data ?? []);

    const userByEmail = new Map<string, ProfileUserInfo>();
    const userById = new Map<string, ProfileUserInfo>();
    for (const row of data ?? []) {
        const email = normalizeEmail(row.email);
        if (!email) continue;
        const info = {
            id: row.user_id as string,
            email,
            display_name: normalizeDisplayName(row.display_name),
            ...(people ? { profile_photo: (row as { profile_photo?: string | null }).profile_photo ?? null } : {}),
        };
        userByEmail.set(email, info);
        userById.set(info.id, info);
    }

    return { userByEmail, userById };
}

export type CreatorProfile = {
    display_name: string | null;
    /** Only lists that already expose creator emails may pass this on. */
    email: string | null;
    profile_photo: string | null;
};

/**
 * Loads the name and photo of each creator of rows the caller is already
 * authorized to list, keyed by user ID. A failed lookup only warns: a missing
 * avatar must never fail the listing that wanted it.
 */
export async function loadCreatorProfiles(
    db: Db,
    rows: { user_id?: string | null }[],
): Promise<Map<string, CreatorProfile>> {
    const byUserId = new Map<string, CreatorProfile>();
    const userIds = [
        ...new Set(
            rows
                .map((row) => row.user_id)
                .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
    ];
    if (userIds.length === 0) return byUserId;
    const { data, error } = await db
        .from("user_profiles")
        .select("user_id, display_name, email, profile_photo")
        .in("user_id", userIds);
    if (error) {
        console.warn("[userLookup] failed to load creator profiles", safeError(error));
        return byUserId;
    }
    for (const row of data ?? []) {
        byUserId.set(row.user_id as string, {
            display_name: normalizeDisplayName(row.display_name),
            email: normalizeEmail(row.email) || null,
            profile_photo: (row as { profile_photo?: string | null }).profile_photo ?? null,
        });
    }
    return byUserId;
}

/** Finds public sharing identity fields without exposing an unscoped photo. */
export async function findProfileUserByEmail(db: Db, email: string) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const { data, error } = await db
        .from("user_profiles")
        .select("user_id, email, display_name")
        .eq("email", normalized)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    return {
        id: data.user_id as string,
        email: normalized,
        display_name: normalizeDisplayName(data.display_name),
    };
}

export async function findMissingUserEmails(db: Db, emails: string[]) {
    const normalizedEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
    if (normalizedEmails.length === 0) return [];

    const { data, error } = await db
        .from("user_profiles")
        .select("email")
        .in("email", normalizedEmails);
    if (error) throw error;

    const found = new Set(
        (data ?? [])
            .map((row) => normalizeEmail(row.email))
            .filter(Boolean),
    );
    return normalizedEmails.filter((email) => !found.has(email));
}

export async function syncProfileEmail(
    db: Db,
    userId: string,
    email: string | null | undefined,
) {
    const normalizedEmail = normalizeEmail(email);
    if (!userId || !normalizedEmail) return null;

    const { data: existing, error: loadError } = await db
        .from("user_profiles")
        .select("email")
        .eq("user_id", userId)
        .maybeSingle();
    if (loadError) return loadError;

    if (!existing) {
        const { error } = await db.from("user_profiles").insert({
            user_id: userId,
            email: normalizedEmail,
        });
        return error;
    }

    if (normalizeEmail(existing.email) === normalizedEmail) return null;

    const { error } = await db
        .from("user_profiles")
        .update({
            email: normalizedEmail,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    return error;
}

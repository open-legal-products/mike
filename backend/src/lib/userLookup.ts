import type { Db } from "./supabase";

export type ProfileUserInfo = {
    id: string;
    email: string;
    display_name: string | null;
};

export function normalizeEmail(value: unknown) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeDisplayName(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function loadProfileUsersByEmail(db: Db) {
    const { data, error } = await db
        .from("user_profiles")
        .select("user_id, email, display_name")
        .not("email", "is", null);
    if (error) throw error;

    const userByEmail = new Map<string, ProfileUserInfo>();
    const userById = new Map<string, ProfileUserInfo>();
    for (const row of data ?? []) {
        const email = normalizeEmail(row.email);
        if (!email) continue;
        const info = {
            id: row.user_id as string,
            email,
            display_name: normalizeDisplayName(row.display_name),
        };
        userByEmail.set(email, info);
        userById.set(info.id, info);
    }

    return { userByEmail, userById };
}

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

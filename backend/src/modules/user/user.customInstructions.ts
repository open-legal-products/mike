// user custom instructions — implementation behind the module facade.
//
// Free-form Markdown the user writes in Settings > Personalisation. It lives
// on user_profiles but is read and written through its own endpoint so the
// profile select cascade (user.profile.storage.ts) does not have to carry a
// potentially large text column on every profile load.
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import { type Db } from "./user.shared";

/** Mirrors the user_profiles_custom_instructions_length check constraint. */
export const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 8000;

export type CustomInstructions = { content: string };

function isMissingColumn(error: unknown): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    return (
        record.code === "42703" &&
        typeof record.message === "string" &&
        record.message.includes("custom_instructions")
    );
}

/**
 * Reads the stored instructions. A database that has not applied the
 * migration yet reads as empty instead of failing every chat request.
 */
export async function loadCustomInstructions(
    db: Db,
    userId: string,
): Promise<string> {
    const { data, error } = await db
        .from("user_profiles")
        .select("custom_instructions")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        if (isMissingColumn(error)) return "";
        throw error;
    }
    const value = (data as { custom_instructions?: unknown } | null)
        ?.custom_instructions;
    return typeof value === "string" ? value : "";
}

export async function getCustomInstructions(
    db: Db,
    userId: string,
): Promise<ServiceResult<CustomInstructions>> {
    try {
        return ok({ content: await loadCustomInstructions(db, userId) });
    } catch (error) {
        return internalFailure(error);
    }
}

export function validateCustomInstructionsPayload(
    body: unknown,
): { ok: true; content: string } | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }
    const content = (body as Record<string, unknown>).content;
    if (typeof content !== "string") {
        return { ok: false, detail: "content must be a string" };
    }
    // Trailing whitespace carries no meaning in a prompt; dropping it also
    // keeps an editor's trailing newline from counting as a change.
    const normalized = content.replace(/\r\n?/g, "\n").trimEnd();
    if (normalized.length > CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
        return {
            ok: false,
            detail: `Custom instructions must be ${CUSTOM_INSTRUCTIONS_MAX_LENGTH} characters or fewer`,
        };
    }
    return { ok: true, content: normalized };
}

export async function saveCustomInstructions(
    db: Db,
    userId: string,
    content: string,
): Promise<ServiceResult<CustomInstructions>> {
    const { data, error } = await db
        .from("user_profiles")
        .update({
            custom_instructions: content,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .select("custom_instructions")
        .maybeSingle();
    if (error) {
        if (isMissingColumn(error)) {
            return failure(
                "unavailable",
                "Custom instructions are not available yet.",
            );
        }
        return internalFailure(error);
    }
    if (!data) return failure("not_found", "Profile not found");
    const saved = (data as { custom_instructions?: unknown })
        .custom_instructions;
    return ok({ content: typeof saved === "string" ? saved : content });
}

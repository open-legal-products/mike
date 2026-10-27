// Shared persistence helpers used by domain services and application workflows.
import type { Db } from "./supabase";
export type { Db };
// Every caller sends this straight to the browser as `{ ok: false, detail }`.
// PostgREST errors are plain objects rather than Errors, so their
// message/details/hint/code are still joined — but an unrecognised value now
// falls back to a generic message instead of JSON.stringify()ing the whole
// object, which could dump request context (including secrets) to the client.
export function errorMessage(error: unknown): string {
    if (error && typeof error === "object" && !(error instanceof Error)) {
        const record = error as {
            message?: unknown;
            details?: unknown;
            hint?: unknown;
            code?: unknown;
        };
        const composed = [
            record.message,
            record.details,
            record.hint,
            record.code,
        ]
            .filter(
                (value): value is string =>
                    typeof value === "string" && !!value,
            )
            .join(" ");
        if (composed) return composed;
    }
    if (error instanceof Error && error.message) return error.message;
    return typeof error === "string" && error ? error : "Unexpected error";
}
export function uniqueStrings(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))];
}
export async function throwIfError<T extends { message?: string } | null>(
    error: T,
    context: string,
) {
    if (error) throw new Error(`${context}: ${error.message ?? "unknown error"}`);
}

// Legacy persistence helper kept for the account-cleanup and project
// lifecycle code that still signals a failed query by throwing an Error
// carrying the database message. It is not the pattern for new services:
// return a ServiceResult (lib/serviceResult.ts) and read through the
// lib/batchedQuery helpers, which throw a fixed-message BatchedQueryError
// with the database error as `cause`.
export async function throwIfError<T extends { message?: string } | null>(
    error: T,
    context: string,
) {
    if (error) throw new Error(`${context}: ${error.message ?? "unknown error"}`);
}

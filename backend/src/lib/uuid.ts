/** The textual form of a Postgres uuid, any case. */
export const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` can name a uuid-keyed row; anything else is never queried. */
export function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

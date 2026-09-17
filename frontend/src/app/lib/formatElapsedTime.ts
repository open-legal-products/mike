/** Compact elapsed time for history rows; omit missing or invalid timestamps. */
export function formatElapsedTime(
    timestamp: string | null | undefined,
    now = Date.now(),
): string | null {
    if (!timestamp) return null;
    const createdAt = Date.parse(timestamp);
    if (!Number.isFinite(createdAt)) return null;
    const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
}

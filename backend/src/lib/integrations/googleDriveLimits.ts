/** Operator-tunable resource budgets. Invalid values fall back to documented
 * defaults; none of these settings can silently disable the limits. */
function positiveInteger(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
export function googleDriveLimits() {
    return {
        // Match Mike's existing per-file upload default.
        downloadBytes:
            positiveInteger("GOOGLE_DRIVE_MAX_FILE_MB", 100) * 1024 * 1024,
        idleMs:
            positiveInteger("GOOGLE_DRIVE_DOWNLOAD_IDLE_SECONDS", 30) * 1000,
        totalMs:
            positiveInteger("GOOGLE_DRIVE_DOWNLOAD_TIMEOUT_SECONDS", 300) *
            1000,
        parseMs:
            positiveInteger("GOOGLE_DRIVE_PARSE_TIMEOUT_SECONDS", 60) * 1000,
        parserHeapMb: positiveInteger("GOOGLE_DRIVE_PARSER_HEAP_MB", 256),
        expandedBytes:
            positiveInteger("GOOGLE_DRIVE_DOCX_EXPANDED_MB", 300) * 1024 * 1024,
    };
}

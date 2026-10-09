// The error the guarded egress path (lib/mcp/client.ts guardedFetch) raises
// when a URL points at, or resolves to, a loopback, private or cloud-metadata
// address. It is shared by MCP connectors and user-supplied LLM endpoints, so
// callers recognise it by its code (it may arrive wrapped, e.g. as the cause
// of undici's "fetch failed") and phrase their own user-facing message.

export const BLOCKED_DESTINATION_CODE = "ERR_BLOCKED_DESTINATION";

export class BlockedDestinationError extends Error {
    readonly code = BLOCKED_DESTINATION_CODE;

    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "BlockedDestinationError";
    }
}

/** True when `error`, or anything in its cause chain, is a guard rejection. */
export function isBlockedDestinationError(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 10 && current; depth++) {
        if (
            typeof current === "object" &&
            (current as { code?: unknown }).code === BLOCKED_DESTINATION_CODE
        ) {
            return true;
        }
        current =
            typeof current === "object"
                ? (current as { cause?: unknown }).cause
                : undefined;
    }
    return false;
}

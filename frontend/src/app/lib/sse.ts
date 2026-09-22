/**
 * Server-Sent Events framing, shared by every streaming call site.
 *
 * The backend streams `data: <json>\n\n` records over a chunked response.
 * Nothing guarantees that network chunk boundaries line up with record
 * boundaries, so a reader has to buffer partial lines, and — because a
 * response is allowed to close without a trailing newline — it also has to
 * flush the decoder and parse whatever is left in the buffer once the body
 * ends. Hand-rolled copies of this loop kept dropping that final record.
 */

/** Thrown when the caller's signal is aborted mid-stream. */
function abortError() {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
}

/**
 * Yields each parsed `data:` payload of an SSE response, in order.
 *
 * - Malformed JSON is warned about and skipped; the stream keeps going.
 * - `data: [DONE]` ends the iteration and is never yielded. The server
 *   closes the body right after it, so the reader is drained to EOF rather
 *   than cancelled: a cancel makes the browser record a request that
 *   completed normally as `net::ERR_ABORTED`, which is noise in DevTools
 *   and in any monitoring that counts aborted requests.
 * - Otherwise the underlying reader is cancelled — on abort, on an early
 *   `break` at the call site, and on a throw from the consumer's body.
 */

/** Read the remaining body to EOF; true when it ended within the budget. */
async function drainToEnd(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    budgetMs: number,
): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
    });
    const drained = (async () => {
        try {
            while (!(await reader.read()).done) {
                /* discard: nothing follows [DONE] */
            }
        } catch {
            /* a torn-down connection has nothing left to release */
        }
        return true;
    })();
    try {
        return await Promise.race([drained, budget]);
    } finally {
        clearTimeout(timer);
    }
}
export async function* readSseFrames(
    response: Response,
    opts?: {
        signal?: AbortSignal;
        /**
         * Called with the `id:` of each yielded frame, before it is yielded.
         * The chat stream numbers its frames so a client that reconnects
         * can ask for the ones it has not seen (`from=<last id + 1>`).
         */
        onEventId?: (id: string) => void;
    },
): AsyncGenerator<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    // An `id:` line applies to the record it precedes.
    let pendingId: string | null = null;

    try {
        while (true) {
            if (opts?.signal?.aborted) throw abortError();

            const { done, value } = await reader.read();
            if (done) {
                // Flush the bytes the decoder still holds, then treat the
                // whole buffer as complete: there is no more input to
                // finish a partial line with.
                buffer += decoder.decode();
            } else {
                buffer += decoder.decode(value, { stream: true });
            }

            const lines = buffer.split("\n");
            buffer = done ? "" : (lines.pop() ?? "");

            for (const line of lines) {
                // trim() also strips the \r of CRLF-delimited streams.
                const trimmed = line.trim();
                if (trimmed.startsWith("id:")) {
                    pendingId = trimmed.slice(3).trim() || null;
                    continue;
                }
                if (!trimmed.startsWith("data:")) continue;

                const payload = trimmed.slice(5).trim();
                if (!payload) continue;
                const id = pendingId;
                pendingId = null;
                if (payload === "[DONE]") {
                    if (id !== null) opts?.onEventId?.(id);
                    finished = true;
                    return;
                }

                let parsed: unknown;
                try {
                    parsed = JSON.parse(payload) as unknown;
                } catch (error) {
                    console.warn("[sse] skipping malformed frame:", {
                        line: trimmed,
                        error,
                    });
                    continue;
                }
                if (id !== null) opts?.onEventId?.(id);
                yield parsed;
            }

            if (done) break;
        }
    } finally {
        // A stream that ended with [DONE] is read to EOF so the request
        // completes normally; anything else — an early break, an abort, a
        // throw from the consumer — releases the connection with a cancel.
        // The drain has a budget so a server that never closes cannot hold
        // the caller: past it, cancel after all.
        if (!finished || !(await drainToEnd(reader, 2_000))) {
            await reader.cancel().catch(() => {});
        }
    }
}

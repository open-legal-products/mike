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
 * - `data: [DONE]` ends the iteration and is never yielded.
 * - The underlying reader is always cancelled — on abort, on an early
 *   `break` at the call site, and on a throw from the consumer's body.
 */
export async function* readSseFrames(
    response: Response,
    opts?: { signal?: AbortSignal },
): AsyncGenerator<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

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
                if (!trimmed.startsWith("data:")) continue;

                const payload = trimmed.slice(5).trim();
                if (!payload) continue;
                if (payload === "[DONE]") return;

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
                yield parsed;
            }

            if (done) break;
        }
    } finally {
        // Releases the connection when the consumer breaks out early, when
        // the signal aborts, and when a handler throws.
        await reader.cancel().catch(() => {});
    }
}

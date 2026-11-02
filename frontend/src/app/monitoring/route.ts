/**
 * Sentry tunnel for the browser SDK (SENTRY_TUNNEL_PATH in
 * app/lib/errorReporting.ts). Browser-side Sentry settings are inlined into
 * the bundle at build time, so a published image cannot read the operator's
 * SENTRY_DISABLED or FRONTEND_SENTRY_DSN. Routing every envelope through this
 * handler restores that: the Next server decides at runtime whether the
 * envelope leaves at all and which project it goes to, then forwards it.
 *
 * This is not an open relay. The destination comes from the server's own
 * environment, never from the request; the client's envelope header is
 * overwritten with that DSN. Nothing in the envelope is logged or stored.
 */
import { type NextRequest, NextResponse } from "next/server";
import { reportingDestination } from "@/app/lib/errorReporting";
import { MAX_ENVELOPE_BYTES, rewriteEnvelope, tunnelDecision } from "@/app/lib/sentryTunnel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let warnedUnreachable = false;

export async function POST(request: NextRequest): Promise<Response> {
    const decision = tunnelDecision(process.env);
    if (decision.kind === "drop") return new NextResponse(null, { status: 204 });

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_ENVELOPE_BYTES) {
        return new NextResponse(null, { status: 413 });
    }
    // Count bytes as they arrive: Content-Length may be absent or dishonest.
    // Do not buffer an unbounded chunked request before enforcing the limit.
    const reader = request.body?.getReader();
    if (!reader) return new NextResponse(null, { status: 400 });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_ENVELOPE_BYTES) {
                // The answer is 413 whatever happens to the cancelled stream.
                void reader.cancel().catch(() => {});
                return new NextResponse(null, { status: 413 });
            }
            chunks.push(value);
        }
    } catch {
        return new NextResponse(null, { status: 400 });
    } finally {
        reader.releaseLock();
    }
    const raw = Buffer.concat(chunks, length);
    if (raw.byteLength === 0) return new NextResponse(null, { status: 400 });

    const envelope = rewriteEnvelope(raw, decision);
    if (!envelope) return new NextResponse(null, { status: 400 });

    try {
        const upstream = await fetch(decision.url, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
            headers: { "Content-Type": "application/x-sentry-envelope" },
            body: envelope.buffer.slice(
                envelope.byteOffset,
                envelope.byteOffset + envelope.byteLength,
            ) as ArrayBuffer,
        });
        // Rate-limit headers let the browser SDK back off; nothing else of
        // Sentry's response is of use to the client.
        const headers = new Headers();
        for (const name of ["retry-after", "x-sentry-rate-limits"]) {
            const value = upstream.headers.get(name);
            if (value) headers.set(name, value);
        }
        // Sentry's answer has been read as far as it matters; release the
        // connection without letting a stream error masquerade as a failed send.
        void upstream.body?.cancel().catch(() => {});
        return new NextResponse(null, { status: upstream.status, headers });
    } catch {
        if (!warnedUnreachable) {
            warnedUnreachable = true;
            console.warn("[sentry] browser error reports could not be forwarded to Sentry");
        }
        return new NextResponse(null, { status: 502 });
    }
}

/**
 * Which rule decides where this deployment's reports go, for operators
 * checking a running container (`curl -s https://<host>/monitoring`). The
 * rule only, never the DSN; a DSN's key is public anyway, but the point of
 * this answer is "which configuration won", not the address.
 */
export function GET(): Response {
    const { source, disabledBy } = reportingDestination(process.env);
    return NextResponse.json(
        {
            reports: source,
            ...(disabledBy ? { disabledBy } : {}),
            see: "docs/observability.md#configuration",
        },
        { headers: { "Cache-Control": "no-store" } },
    );
}

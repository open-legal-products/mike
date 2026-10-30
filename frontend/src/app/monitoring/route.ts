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
import {
    MIKE_SENTRY_DSN,
    installKind,
    resolveDsn,
} from "@/shared/lib/sentryEvent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Envelopes are small (the privacy boundary strips attachments); refuse more. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;

export type TunnelDecision =
    | { kind: "drop" }
    | {
          kind: "forward";
          /** Sentry's envelope endpoint for the runtime-resolved DSN. */
          url: string;
          /** The DSN written into the envelope header (authenticates it). */
          dsn: string;
          /** Runtime overrides applied to every event item, when set. */
          environment?: string;
          install?: string;
      };

type ParsedDsn = { protocol: string; host: string; projectId: string };

function parseDsn(dsn: string): ParsedDsn | null {
    let url: URL;
    try {
        url = new URL(dsn);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const projectId = url.pathname.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
    if (!url.username || !/^\d+$/.test(projectId)) return null;
    return { protocol: url.protocol.slice(0, -1), host: url.host, projectId };
}

/**
 * Where a browser envelope goes, from the Next server's runtime environment
 * (the same variables serverSentryOptions reads): off, the operator's own
 * DSN, or the built-in Mike project DSN. A malformed DSN drops the envelope
 * rather than falling back upstream: the operator asked for their own Sentry.
 */
export function tunnelDecision(env: NodeJS.ProcessEnv): TunnelDecision {
    const { dsn } = resolveDsn({
        disabled: env.SENTRY_DISABLED,
        dsn: env.SENTRY_DSN,
        fallback: MIKE_SENTRY_DSN.frontend,
    });
    if (!dsn) return { kind: "drop" };
    const parsed = parseDsn(dsn);
    if (!parsed) return { kind: "drop" };
    const install = env.SENTRY_INSTALL?.trim();
    const environment = env.SENTRY_ENVIRONMENT?.trim();
    return {
        kind: "forward",
        url: `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/envelope/`,
        dsn,
        ...(environment ? { environment } : {}),
        ...(install ? { install: installKind(install) } : {}),
    };
}

const NEWLINE = 0x0a;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function lineEnd(bytes: Uint8Array, from: number): number {
    const index = bytes.indexOf(NEWLINE, from);
    return index === -1 ? bytes.length : index;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(decoder.decode(bytes));
        return value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * Re-emit an envelope with the header DSN replaced and, when the deployment
 * sets them, `environment` and `tags.install` applied to every event item.
 * Items are walked by the envelope framing (header line, then item header
 * and payload pairs; a `length` counts payload bytes) so payloads are never
 * misread; anything that does not parse returns null and is not forwarded.
 */
export function rewriteEnvelope(
    raw: Uint8Array,
    patch: { dsn: string; environment?: string; install?: string },
): Uint8Array | null {
    const headerEnd = lineEnd(raw, 0);
    const header = parseJsonObject(raw.subarray(0, headerEnd));
    if (!header) return null;
    header.dsn = patch.dsn;
    const parts: Uint8Array[] = [encoder.encode(JSON.stringify(header))];

    let cursor = headerEnd + 1;
    while (cursor < raw.length) {
        const itemHeaderEnd = lineEnd(raw, cursor);
        if (itemHeaderEnd === cursor) {
            // Blank line: trailing newline at the end of the envelope.
            cursor += 1;
            continue;
        }
        const itemHeader = parseJsonObject(raw.subarray(cursor, itemHeaderEnd));
        if (!itemHeader) return null;
        const payloadStart = itemHeaderEnd + 1;
        if (payloadStart > raw.length) return null;
        const declared = itemHeader.length;
        const payloadEnd =
            typeof declared === "number" && Number.isInteger(declared) && declared >= 0
                ? payloadStart + declared
                : lineEnd(raw, payloadStart);
        if (payloadEnd > raw.length) return null;
        let payload = raw.subarray(payloadStart, payloadEnd);

        if (itemHeader.type === "event" && (patch.environment || patch.install)) {
            const event = parseJsonObject(payload);
            if (!event) return null;
            if (patch.environment) event.environment = patch.environment;
            if (patch.install) {
                const tags =
                    event.tags && typeof event.tags === "object" && !Array.isArray(event.tags)
                        ? (event.tags as Record<string, unknown>)
                        : {};
                tags.install = patch.install;
                event.tags = tags;
            }
            payload = encoder.encode(JSON.stringify(event));
            if (typeof declared === "number") itemHeader.length = payload.byteLength;
        }
        parts.push(encoder.encode(JSON.stringify(itemHeader)), payload);
        cursor = payloadEnd + 1;
    }

    const total = parts.reduce((sum, part) => sum + part.byteLength + 1, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
        out[offset] = NEWLINE;
        offset += 1;
    }
    return out;
}

let warnedUnreachable = false;

export async function POST(request: NextRequest): Promise<Response> {
    const decision = tunnelDecision(process.env);
    if (decision.kind === "drop") return new NextResponse(null, { status: 204 });

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_ENVELOPE_BYTES) {
        return new NextResponse(null, { status: 413 });
    }
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength === 0 || raw.byteLength > MAX_ENVELOPE_BYTES) {
        return new NextResponse(null, { status: raw.byteLength === 0 ? 400 : 413 });
    }

    const envelope = rewriteEnvelope(raw, decision);
    if (!envelope) return new NextResponse(null, { status: 400 });

    try {
        const upstream = await fetch(decision.url, {
            method: "POST",
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
        return new NextResponse(null, { status: upstream.status, headers });
    } catch {
        if (!warnedUnreachable) {
            warnedUnreachable = true;
            console.warn("[sentry] browser error reports could not be forwarded to Sentry");
        }
        return new NextResponse(null, { status: 502 });
    }
}

export function GET(): Response {
    return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}

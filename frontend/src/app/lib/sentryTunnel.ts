import { reportingDestination } from "./errorReporting";

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

type ParsedDsn = { protocol: string; host: string; path: string; projectId: string };

function parseDsn(dsn: string): ParsedDsn | null {
    let url: URL;
    try {
        url = new URL(dsn);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    // split() never yields an empty array, so pop() is a string; "" when the
    // DSN has no path at all.
    const projectId = segments.pop() as string;
    if (!url.username || !/^\d+$/.test(projectId)) return null;
    return { protocol: url.protocol.slice(0, -1), host: url.host, path: segments.length ? `/${segments.join("/")}` : "", projectId };
}

/**
 * Where a browser envelope goes: the same `reportingDestination` the Next
 * server's own SDK uses (app/lib/errorReporting.ts), so server and browser
 * reports can never end up in different projects. A malformed DSN drops the
 * envelope rather than falling back upstream: the operator asked for their
 * own Sentry.
 */
export function tunnelDecision(env: NodeJS.ProcessEnv): TunnelDecision {
    const destination = reportingDestination(env);
    if (!destination.dsn) return { kind: "drop" };
    const parsed = parseDsn(destination.dsn);
    if (!parsed) return { kind: "drop" };
    return {
        kind: "forward",
        url: `${parsed.protocol}://${parsed.host}${parsed.path}/api/${parsed.projectId}/envelope/`,
        dsn: destination.dsn,
        ...(destination.environment ? { environment: destination.environment } : {}),
        ...(destination.install ? { install: destination.install } : {}),
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


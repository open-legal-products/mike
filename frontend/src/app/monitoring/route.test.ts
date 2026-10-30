// @vitest-environment node
// A route handler: plain Node, no DOM. (jsdom's Blob cannot be read by fetch.)
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIKE_SENTRY_DSN } from "@/shared/lib/sentryEvent";
import {
    GET,
    MAX_ENVELOPE_BYTES,
    POST,
    rewriteEnvelope,
    tunnelDecision,
} from "./route";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const OWN_DSN = "https://abc123@o777.ingest.us.sentry.io/4242";

function envelope(lines: (string | object)[]): Uint8Array {
    return encoder.encode(
        lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    );
}

function parsedLines(bytes: Uint8Array | null): unknown[] {
    expect(bytes).not.toBeNull();
    return decoder
        .decode(bytes!)
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown);
}

describe("tunnelDecision", () => {
    it("drops every envelope when the deployment opts out at runtime", () => {
        expect(tunnelDecision({ SENTRY_DISABLED: "true", SENTRY_DSN: OWN_DSN } as unknown as NodeJS.ProcessEnv)).toEqual({
            kind: "drop",
        });
    });

    it("forwards to the operator's own project when a DSN is set at runtime", () => {
        expect(tunnelDecision({ SENTRY_DSN: ` ${OWN_DSN} ` } as unknown as NodeJS.ProcessEnv)).toEqual({
            kind: "forward",
            url: "https://o777.ingest.us.sentry.io/api/4242/envelope/",
            dsn: OWN_DSN,
        });
    });

    it("forwards to the built-in Mike project otherwise, with runtime tags", () => {
        const decision = tunnelDecision({
            SENTRY_ENVIRONMENT: "production",
            SENTRY_INSTALL: "official",
        } as unknown as NodeJS.ProcessEnv);
        expect(decision).toMatchObject({
            kind: "forward",
            dsn: MIKE_SENTRY_DSN.frontend,
            environment: "production",
            install: "official",
        });
        expect((decision as { url: string }).url).toMatch(
            /^https:\/\/o\d+\.ingest\.us\.sentry\.io\/api\/\d+\/envelope\/$/,
        );
        expect(tunnelDecision({ SENTRY_INSTALL: "anything-else" } as unknown as NodeJS.ProcessEnv)).toMatchObject({
            install: "community",
        });
    });

    it("drops rather than falls back upstream when the operator's DSN is malformed", () => {
        expect(tunnelDecision({ SENTRY_DSN: "not a dsn" } as unknown as NodeJS.ProcessEnv)).toEqual({ kind: "drop" });
        expect(tunnelDecision({ SENTRY_DSN: "https://host.example/no-project" } as unknown as NodeJS.ProcessEnv)).toEqual({
            kind: "drop",
        });
        expect(tunnelDecision({ SENTRY_DSN: "ftp://k@host.example/1" } as unknown as NodeJS.ProcessEnv)).toEqual({
            kind: "drop",
        });
    });
});

describe("rewriteEnvelope", () => {
    const event = { event_id: "a".repeat(32), environment: "self-hosted", tags: { install: "community", runtime: "browser" } };

    it("replaces the header DSN and leaves items alone without overrides", () => {
        const out = rewriteEnvelope(
            envelope([{ dsn: "https://client@o1.ingest.sentry.io/1", event_id: event.event_id }, { type: "event" }, event]),
            { dsn: OWN_DSN },
        );
        expect(parsedLines(out)).toEqual([{ dsn: OWN_DSN, event_id: event.event_id }, { type: "event" }, event]);
    });

    it("applies environment and install to event items only", () => {
        const out = rewriteEnvelope(
            envelope([
                { dsn: "x" },
                { type: "event" },
                event,
                { type: "client_report" },
                { discarded_events: [] },
            ]),
            { dsn: OWN_DSN, environment: "production", install: "official" },
        );
        expect(parsedLines(out)).toEqual([
            { dsn: OWN_DSN },
            { type: "event" },
            { ...event, environment: "production", tags: { install: "official", runtime: "browser" } },
            { type: "client_report" },
            { discarded_events: [] },
        ]);
    });

    it("honours a declared item length and updates it after rewriting", () => {
        const payload = JSON.stringify({ event_id: "b".repeat(32) });
        const out = rewriteEnvelope(
            envelope([{ dsn: "x" }, { type: "event", length: payload.length }, payload]),
            { dsn: OWN_DSN, environment: "staging" },
        );
        const lines = parsedLines(out) as [unknown, { length: number }, { environment: string }];
        expect(lines[2]).toEqual({ event_id: "b".repeat(32), environment: "staging" });
        expect(lines[1].length).toBe(JSON.stringify(lines[2]).length);
    });

    it("refuses envelopes it cannot parse instead of forwarding them", () => {
        expect(rewriteEnvelope(encoder.encode("not json\n"), { dsn: OWN_DSN })).toBeNull();
        expect(rewriteEnvelope(envelope([{ dsn: "x" }, "garbage", "{}"]), { dsn: OWN_DSN })).toBeNull();
        expect(
            rewriteEnvelope(envelope([{ dsn: "x" }, { type: "event", length: 999 }, "{}"]), { dsn: OWN_DSN }),
        ).toBeNull();
        expect(
            rewriteEnvelope(envelope([{ dsn: "x" }, { type: "event" }, "not an event"]), {
                dsn: OWN_DSN,
                environment: "production",
            }),
        ).toBeNull();
    });
});

describe("POST /monitoring", () => {
    const fetchMock = vi.fn();
    const originalEnv = { ...process.env };

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        delete process.env.SENTRY_DISABLED;
        delete process.env.SENTRY_DSN;
        delete process.env.SENTRY_ENVIRONMENT;
        delete process.env.SENTRY_INSTALL;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        process.env = { ...originalEnv };
    });

    function post(body: Uint8Array | string, headers: Record<string, string> = {}) {
        return POST(
            new NextRequest("http://localhost:3000/monitoring", {
                method: "POST",
                headers: { "content-type": "application/x-sentry-envelope", ...headers },
                body: typeof body === "string" ? body : decoder.decode(body),
            }),
        );
    }

    it("forwards the rewritten envelope to the runtime DSN and relays the status", async () => {
        process.env.SENTRY_DSN = OWN_DSN;
        process.env.SENTRY_ENVIRONMENT = "production";
        fetchMock.mockResolvedValue(
            new Response("{}", { status: 429, headers: { "retry-after": "60", "x-sentry-rate-limits": "60::" } }),
        );
        const response = await post(
            envelope([{ dsn: "https://client@o1.ingest.sentry.io/1" }, { type: "event" }, { event_id: "c".repeat(32) }]),
        );
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("60");
        expect(response.headers.get("x-sentry-rate-limits")).toBe("60::");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://o777.ingest.us.sentry.io/api/4242/envelope/");
        expect(init.method).toBe("POST");
        expect(parsedLines(new Uint8Array(init.body as ArrayBuffer))).toEqual([
            { dsn: OWN_DSN },
            { type: "event" },
            { event_id: "c".repeat(32), environment: "production" },
        ]);
    });

    it("answers 204 and sends nothing when the deployment is opted out", async () => {
        process.env.SENTRY_DISABLED = "true";
        const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
        expect(response.status).toBe(204);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects oversized, empty and unparseable envelopes without forwarding", async () => {
        expect((await post("", { "content-length": String(MAX_ENVELOPE_BYTES + 1) })).status).toBe(413);
        expect((await post("x".repeat(MAX_ENVELOPE_BYTES + 1))).status).toBe(413);
        expect((await post("")).status).toBe(400);
        expect((await post("not an envelope\n")).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("answers 502 when Sentry is unreachable", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
        expect(response.status).toBe(502);
        warn.mockRestore();
    });

    it("only accepts POST", () => {
        expect(GET().status).toBe(405);
    });
});

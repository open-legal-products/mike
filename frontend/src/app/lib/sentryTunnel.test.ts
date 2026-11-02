// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MIKE_SENTRY_DSN } from "@/shared/lib/sentryEvent";
import { rewriteEnvelope, tunnelDecision } from "./sentryTunnel";

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
    it("preserves a self-hosted Sentry URL prefix and port", () => {
        expect(tunnelDecision({ NODE_ENV: "test", SENTRY_DSN: "https://key@sentry.example:8443/errors/42" })).toMatchObject({
            kind: "forward",
            url: "https://sentry.example:8443/errors/api/42/envelope/",
        });
    });

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

    it("falls back to the DSN baked at build before the built-in one", () => {
        expect(
            tunnelDecision({ NEXT_PUBLIC_SENTRY_DSN: OWN_DSN } as unknown as NodeJS.ProcessEnv),
        ).toMatchObject({ kind: "forward", dsn: OWN_DSN });
        // The runtime variable is the single source of truth and wins.
        expect(
            tunnelDecision({
                NEXT_PUBLIC_SENTRY_DSN: "https://baked@o1.ingest.sentry.io/1",
                SENTRY_DSN: OWN_DSN,
            } as unknown as NodeJS.ProcessEnv),
        ).toMatchObject({ dsn: OWN_DSN });
    });

    it("drops a DSN with a key but no numeric project", () => {
        expect(tunnelDecision({ SENTRY_DSN: "https://k@host.example/" } as unknown as NodeJS.ProcessEnv)).toEqual({
            kind: "drop",
        });
        expect(tunnelDecision({ SENTRY_DSN: "https://k@host.example" } as unknown as NodeJS.ProcessEnv)).toEqual({
            kind: "drop",
        });
        expect(tunnelDecision({ SENTRY_DSN: "https://k@host.example/not-a-number" } as unknown as NodeJS.ProcessEnv)).toEqual({
            kind: "drop",
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

    it("handles envelopes without a trailing newline and with blank lines between items", () => {
        // Header only, no newline at all.
        expect(parsedLines(rewriteEnvelope(encoder.encode('{"dsn":"x"}'), { dsn: OWN_DSN }))).toEqual([{ dsn: OWN_DSN }]);
        // Payload is the last line and has no newline after it.
        expect(
            parsedLines(rewriteEnvelope(encoder.encode('{"dsn":"x"}\n{"type":"event"}\n{"event_id":"e"}'), { dsn: OWN_DSN })),
        ).toEqual([{ dsn: OWN_DSN }, { type: "event" }, { event_id: "e" }]);
        // A blank line between items is skipped, not read as an item header.
        expect(
            parsedLines(rewriteEnvelope(encoder.encode('{"dsn":"x"}\n\n{"type":"event"}\n{"event_id":"e"}\n'), { dsn: OWN_DSN })),
        ).toEqual([{ dsn: OWN_DSN }, { type: "event" }, { event_id: "e" }]);
    });

    it("applies install alone, creating tags when the event has none or has a non-object", () => {
        const out = rewriteEnvelope(
            envelope([
                { dsn: "x" },
                { type: "event" },
                { event_id: "a", environment: "self-hosted" },
                { type: "event" },
                { event_id: "b", tags: ["not", "an", "object"] },
            ]),
            { dsn: OWN_DSN, install: "official" },
        );
        expect(parsedLines(out)).toEqual([
            { dsn: OWN_DSN },
            { type: "event" },
            { event_id: "a", environment: "self-hosted", tags: { install: "official" } },
            { type: "event" },
            { event_id: "b", tags: { install: "official" } },
        ]);
    });

    it("refuses JSON that is not an object, and an item header with no payload line", () => {
        expect(rewriteEnvelope(encoder.encode("[1,2]\n"), { dsn: OWN_DSN })).toBeNull();
        expect(rewriteEnvelope(encoder.encode("null\n"), { dsn: OWN_DSN })).toBeNull();
        expect(rewriteEnvelope(encoder.encode('"just a string"\n'), { dsn: OWN_DSN })).toBeNull();
        expect(rewriteEnvelope(encoder.encode('{"dsn":"x"}\n{"type":"event"}'), { dsn: OWN_DSN })).toBeNull();
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

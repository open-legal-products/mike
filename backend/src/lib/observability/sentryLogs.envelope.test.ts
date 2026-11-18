/**
 * Structured logs and metrics through the real SDK and the privacy boundary:
 * what the final envelopes hold with SENTRY_LOGS on, and that nothing leaves
 * without it.
 */
import { afterEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { countMetric, log, logEvent, setLogForwarder, tpl } from "../log";
import { privacyBoundaryIntegration, type TelemetryBudget } from "./sentryPrivacy";
import { resetSentryForTests, sentryLogsEnabled, sentryLogsPerDay, telemetryBudget } from "./sentry";

type Item = Record<string, unknown> & { attributes: Record<string, { value: unknown; type: string }> };
type Sent = { type: string; header: Record<string, unknown>; items: Item[] };

afterEach(async () => {
    setLogForwarder(null);
    await Sentry.close();
    vi.restoreAllMocks();
});

function start(telemetry?: TelemetryBudget) {
    const sent: Sent[] = [];
    resetSentryForTests("community");
    Sentry.init({
        dsn: "https://test@sentry.invalid/1",
        environment: "production",
        release: "mike@2.0.0",
        defaultIntegrations: false,
        integrations: [privacyBoundaryIntegration({ telemetry })],
        transport: () => ({
            send: async envelope => {
                for (const [header, payload] of envelope[1]) {
                    sent.push({
                        type: header.type,
                        header: header as Record<string, unknown>,
                        items: ((payload as { items?: Item[] }).items ?? []),
                    });
                }
                return { statusCode: 200 };
            },
            flush: async () => true,
        }),
    });
    // What initSentry installs when SENTRY_LOGS=on.
    setLogForwarder({
        log: (level, body, attributes) => Sentry.logger[level](body, attributes),
        metric: (name, value, attributes) => Sentry.metrics.count(name, value, { attributes }),
    });
    return sent;
}

it("sends a log's static text and identifier attributes, and nothing a call printed beside them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sent = start(() => 100);
    Sentry.setUser({ id: "user-PRIVATE_CANARY", email: "PRIVATE_CANARY@example.com" });

    log.warn("dbq", "poll failed", new Error("PRIVATE_CANARY in an error"));
    log.info(tpl`[queue] redis still unreachable after ${7} minutes for ${"PRIVATE_CANARY"}`);
    logEvent("info", "tool-activity", "counted", {
        kind: "tool_input",
        tool: "read_document",
        outcome: "refused",
        count: 2,
        note: "PRIVATE_CANARY has spaces, so it is not an identifier",
    });
    countMetric("tool_activity", 2, { kind: "tool_input", tool: "read_document", outcome: "refused" });
    await Sentry.flush(2000);

    const logs = sent.filter(s => s.type === "log").flatMap(s => s.items);
    expect(logs.map(l => [l.level, l.body])).toEqual([
        ["warn", "[dbq] poll failed"],
        ["info", "[queue] redis still unreachable after {} minutes for {}"],
        ["info", "[tool-activity] counted"],
    ]);
    expect(logs[2].attributes).toEqual({
        kind: { value: "tool_input", type: "string" },
        tool: { value: "read_document", type: "string" },
        outcome: { value: "refused", type: "string" },
        count: { value: 2, type: "integer" },
        "sentry.environment": { value: "production", type: "string" },
        "sentry.release": { value: "mike@2.0.0", type: "string" },
    });

    const metrics = sent.filter(s => s.type === "trace_metric").flatMap(s => s.items);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ name: "tool_activity", type: "counter", value: 2 });
    expect(metrics[0].attributes).toMatchObject({ tool: { value: "read_document", type: "string" } });

    for (const container of sent) {
        expect(container.header).toEqual({
            type: container.type,
            item_count: container.items.length,
            content_type: expect.stringMatching(/^application\/vnd\.sentry\.items\./),
        });
    }
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("PRIVATE_CANARY");
    expect(wire).not.toContain("user.");
    expect(wire).not.toContain("server.address");
});

it("sends no log or metric unless the runtime opted in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent = start();
    log.warn("dbq", "poll failed");
    countMetric("tool_activity", 1, { kind: "script_run" });
    await Sentry.flush(2000);
    expect(sent).toEqual([]);
});

it("stops at the daily limit and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = Date.UTC(2026, 10, 18, 12);
    const sent = start(telemetryBudget(2, () => now));
    for (let i = 0; i < 5; i += 1) logEvent("info", "dbq", "runner started");
    await Sentry.flush(2000);
    expect(sent.flatMap(s => s.items)).toHaveLength(2);
    expect(warn.mock.calls.filter(([line]) => String(line).startsWith("[sentry] the daily limit"))).toHaveLength(1);

    now += 24 * 60 * 60_000;
    logEvent("info", "dbq", "runner started");
    await Sentry.flush(2000);
    expect(sent.flatMap(s => s.items)).toHaveLength(3);
});

it("is off unless SENTRY_LOGS=on, with a limit that can be set", () => {
    expect(sentryLogsEnabled({})).toBe(false);
    expect(sentryLogsEnabled({ SENTRY_LOGS: "off" })).toBe(false);
    expect(sentryLogsEnabled({ SENTRY_LOGS: " ON " })).toBe(true);
    expect(sentryLogsPerDay({})).toBe(5000);
    expect(sentryLogsPerDay({ SENTRY_MAX_LOGS_PER_DAY: "200" })).toBe(200);
    expect(sentryLogsPerDay({ SENTRY_MAX_LOGS_PER_DAY: "many" })).toBe(5000);
});

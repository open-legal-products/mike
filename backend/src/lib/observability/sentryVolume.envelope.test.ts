import { afterEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { eventBudget } from "./sentryVolume";
import { privacyBoundaryIntegration } from "./sentryPrivacy";
import { resetSentryForTests, scrubEvent } from "./sentry";

afterEach(async () => {
    await Sentry.close();
    vi.restoreAllMocks();
});

it("reserves new/severe reports across quiet resets and logs the ceiling without another envelope", async () => {
    let now = 0;
    const events: Sentry.Event[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSentryForTests("community");
    Sentry.init({
        dsn: "https://test@sentry.invalid/1",
        defaultIntegrations: false,
        integrations: [
            privacyBoundaryIntegration({ acceptEvent: eventBudget({ now: () => now }) }),
            Sentry.captureConsoleIntegration({ levels: ["error"] }),
        ],
        beforeSend: scrubEvent,
        transport: () => ({
            send: async envelope => {
                for (const [header, payload] of envelope[1]) {
                    if (header.type === "event") events.push(payload as Sentry.Event);
                }
                return { statusCode: 200 };
            },
            flush: async () => true,
        }),
    });
    const capture = (code: string, level: Sentry.SeverityLevel = "warning") => {
        const error = new Error("PRIVATE_VOLUME_CANARY");
        error.stack = "Error: PRIVATE_VOLUME_CANARY\n    at warn (backend/src/runtime.ts:42:1)";
        Sentry.captureException(error, {
            level,
            tags: { component: "runtime-warning", warning_name: "DeprecationWarning", warning_code: code },
            extra: { secret: "PRIVATE_VOLUME_CANARY" },
        });
    };
    for (let hour = 0; hour < 24; hour++) {
        now = hour * 61 * 60_000;
        capture("DEP9901");
        capture("DEP9902");
        await Sentry.flush(2000);
    }
    expect(events).toHaveLength(27); // Two daily firsts plus 25 quiet recurrences.
    capture("DEP9901", "error");
    capture("DEP9903");
    await Sentry.flush(2000);
    expect(events).toHaveLength(29);
    expect(events[27]?.level).toBe("error");
    for (let id = 4; id < 40; id++) capture(`DEP${9900 + id}`);
    await Sentry.flush(2000);
    expect(events).toHaveLength(50);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([events, warn.mock.calls])).not.toContain("PRIVATE_VOLUME_CANARY");
});

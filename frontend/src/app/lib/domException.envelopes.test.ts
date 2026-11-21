import { afterEach, expect, it } from "vitest";
import * as Sentry from "@sentry/react";
import { createEventScrubber, privacyBoundaryIntegration } from "@mike/client";

afterEach(async () => { await Sentry.close(); });
it.each([
    ["official", true], ["official", false], ["community", true], ["community", false],
] as const)("preserves DOMException diagnoses and privacy in final %s envelopes (stack=%s)", async (install, withStack) => {
    const events: Sentry.Event[] = [];
    const scrubber = createEventScrubber({ install });
    Sentry.init({
        dsn: "https://test@sentry.invalid/1", defaultIntegrations: false, attachStacktrace: true,
        integrations: [privacyBoundaryIntegration()], beforeSend: (event, hint) => scrubber.scrubEvent(event, hint),
        transport: () => ({ send: async envelope => {
            for (const [header, payload] of envelope[1]) if (header.type === "event") events.push(payload as Sentry.Event);
            return { statusCode: 200 };
        }, flush: async () => true }),
    });
    const error = new DOMException("PRIVATE_DOCUMENT_TEXT", "NotFoundError");
    if (!withStack) delete (error as unknown as { stack?: string }).stack;
    Sentry.captureException(error);
    const custom = new DOMException("PRIVATE_DOCUMENT_TEXT", "PrivateCustomerError");
    if (!withStack) delete (custom as unknown as { stack?: string }).stack;
    Sentry.captureException(custom);
    // Naming an AbortError is not evidence that its owner handled it.
    const abort = new DOMException("PRIVATE_REQUEST", "AbortError");
    if (!withStack) delete (abort as unknown as { stack?: string }).stack;
    Sentry.captureException(abort, { mechanism: { type: "generic", handled: false } });
    const handled = new DOMException("PRIVATE_HANDLED", "AbortError");
    scrubber.markReported(handled);
    Sentry.captureException(handled, { mechanism: { type: "generic", handled: false } });
    await Sentry.flush(2000);
    expect(events).toHaveLength(3);
    expect(events[0].exception?.values?.[0].type).toBe("NotFoundError");
    expect(events[2].exception?.values?.[0]).toMatchObject({ type: "AbortError", mechanism: { handled: false } });
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|PrivateCustomerError/);
});

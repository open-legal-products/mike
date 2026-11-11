import { expect, it, vi } from "vitest";
import { MIKE_SENTRY_DSN } from "@mike/client";
import { serverSentryOptions } from "./errorReporting";
import { addinSentryOptions } from "../../../../word-addin/src/taskpane/lib/errorReporting";

it.each(["server", "edge", "addin"] as const)("%s caps an explicit Mike DSN but leaves custom projects independent", async runtime => {
    for (const [dsn, count] of [[MIKE_SENTRY_DSN.frontend, 50], ["https://own@sentry.invalid/42", 60]] as const) {
        const options = runtime === "addin"
            ? addinSentryOptions("taskpane", { nodeEnv: "production", dsn })
            : serverSentryOptions(runtime, { NODE_ENV: "production", SENTRY_DSN: dsn });
        const integrations = options.integrations;
        if (!Array.isArray(integrations)) throw new Error("Expected explicit integrations");
        const integration = integrations.find(item => item.name === "MikePrivacyBoundary");
        const send = vi.fn(async (_envelope: unknown) => ({ statusCode: 200 }));
        const transport = { send };
        // Drive the configured final transport, not a separately constructed budget.
        (integration as unknown as { setup(client: unknown): void }).setup({ getTransport: () => transport });
        for (let n = 0; n < 60; n++) await transport.send([{}, [[{ type: "event" }, { message: "PRIVATE_QUOTA_CANARY", tags: { diagnostic_test: "true" } }]]]);
        expect(send).toHaveBeenCalledTimes(count);
        expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE_QUOTA_CANARY");
    }
});

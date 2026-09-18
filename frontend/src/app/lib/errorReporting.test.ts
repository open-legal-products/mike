import { afterEach, describe, expect, it, vi } from "vitest";

type FakeScope = {
    setLevel: ReturnType<typeof vi.fn>;
    setTag: ReturnType<typeof vi.fn>;
    setExtra: ReturnType<typeof vi.fn>;
    setFingerprint: ReturnType<typeof vi.fn>;
};

const state = vi.hoisted(() => ({
    enabled: false,
    scopes: [] as FakeScope[],
}));

vi.mock("@sentry/nextjs", () => ({
    isEnabled: () => state.enabled,
    captureException: vi.fn(() => "exc-1"),
    captureMessage: vi.fn(() => "msg-1"),
    setUser: vi.fn(),
    captureConsoleIntegration: vi.fn((opts: unknown) => ({
        name: "CaptureConsole",
        opts,
    })),
    withScope: (cb: (scope: FakeScope) => unknown) => {
        const scope: FakeScope = {
            setLevel: vi.fn(),
            setTag: vi.fn(),
            setExtra: vi.fn(),
            setFingerprint: vi.fn(),
        };
        state.scopes.push(scope);
        return cb(scope);
    },
}));

import * as Sentry from "@sentry/nextjs";
import {
    browserSentryOptions,
    reportApiFailure,
    reportError,
    scrubEvent,
    serverSentryOptions,
    setReportingUser,
    reportNetworkFailure,
} from "./errorReporting";
import { MIKE_SENTRY_DSN } from "@/shared/lib/sentryEvent";

afterEach(() => {
    state.enabled = false;
    state.scopes.length = 0;
    vi.clearAllMocks();
});

describe("reportError", () => {
    it("is a no-op without a DSN but still marks the error for the console bridge", () => {
        const error = new Error("x");
        expect(reportError(error, { tags: { a: "b" } })).toBeNull();
        expect(Sentry.captureException).not.toHaveBeenCalled();

        const consoleCopy = {
            exception: { values: [{ mechanism: { type: "auto.core.capture_console" } }] },
        };
        expect(scrubEvent(consoleCopy, { originalException: error })).toBeNull();
    });

    it("captures with tags, extra, level, and fingerprint when enabled", () => {
        state.enabled = true;
        const error = new Error("boom");

        expect(
            reportError(error, {
                level: "warning",
                fingerprint: ["a", "b"],
                tags: { component: "x", count: 2, skip: undefined, gone: null },
                extra: { detail: "d" },
            }),
        ).toBe("exc-1");

        expect(Sentry.captureException).toHaveBeenCalledWith(error);
        const scope = state.scopes[0];
        expect(scope.setLevel).toHaveBeenCalledWith("warning");
        expect(scope.setFingerprint).toHaveBeenCalledWith(["a", "b"]);
        expect(scope.setTag).toHaveBeenCalledWith("component", "x");
        expect(scope.setTag).toHaveBeenCalledWith("count", 2);
        expect(scope.setTag).toHaveBeenCalledTimes(2);
        expect(scope.setExtra).toHaveBeenCalledWith("detail", "d");
    });

    it("accepts an empty context", () => {
        state.enabled = true;
        reportError(new Error("bare"));
        expect(state.scopes[0].setLevel).not.toHaveBeenCalled();
        expect(state.scopes[0].setFingerprint).not.toHaveBeenCalled();
    });
});

describe("reportApiFailure", () => {
    it("does nothing while disabled", () => {
        expect(reportApiFailure({ path: "/x", status: 500 })).toBeNull();
        expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("groups by normalized route and carries the backend request id", () => {
        state.enabled = true;

        const id = reportApiFailure({
            path: "/projects/8f1c2a3e-1234-4bcd-9e0f-1234567890ab?x=1",
            status: 502,
            code: "internal_error",
            requestId: "req-9",
            method: "DELETE",
        });

        expect(id).toBe("msg-1");
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
            "API 502 on DELETE /projects/:id",
            "error",
        );
        const scope = state.scopes[0];
        expect(scope.setFingerprint).toHaveBeenCalledWith([
            "api-5xx",
            "DELETE",
            "/projects/:id",
            "502",
        ]);
        expect(scope.setTag).toHaveBeenCalledWith("request_id", "req-9");
        expect(scope.setTag).toHaveBeenCalledWith("error_code", "internal_error");
        expect(scope.setTag).toHaveBeenCalledWith("http_status", 502);
        expect(scope.setExtra).toHaveBeenCalledWith(
            "path",
            "/projects/8f1c2a3e-1234-4bcd-9e0f-1234567890ab?x=1",
        );
    });

    it("marks the thrown error so the console bridge drops its later copy", () => {
        const apiError = new Error("Something went wrong");
        reportApiFailure({ path: "/x", status: 500, error: apiError });
        const consoleCopy = {
            exception: { values: [{ mechanism: { type: "auto.core.capture_console" } }] },
        };
        expect(scrubEvent(consoleCopy, { originalException: apiError })).toBeNull();
    });

    it("defaults the method to GET and omits absent tags", () => {
        state.enabled = true;
        reportApiFailure({ path: "/user/profile", status: 500 });
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
            "API 500 on GET /user/profile",
            "error",
        );
        expect(state.scopes[0].setTag).not.toHaveBeenCalledWith(
            "request_id",
            expect.anything(),
        );
    });
});

describe("setReportingUser", () => {
    it("is a no-op while disabled", () => {
        setReportingUser({ id: "u1" });
        expect(Sentry.setUser).not.toHaveBeenCalled();
    });

    it("sends only the id, and null on sign-out", () => {
        state.enabled = true;
        setReportingUser({ id: "u1" });
        setReportingUser(null);
        expect(Sentry.setUser).toHaveBeenNthCalledWith(1, { id: "u1" });
        expect(Sentry.setUser).toHaveBeenNthCalledWith(2, null);
    });
});

describe("browserSentryOptions", () => {
    it("is ON BY DEFAULT with the Mike project DSN and never turns on PII or replay", () => {
        const options = browserSentryOptions({ nodeEnv: "test" });
        expect(options.enabled).toBe(true);
        expect(options.dsn).toBe(MIKE_SENTRY_DSN.frontend);
        expect(options.environment).toBe("self-hosted");
        expect(options.release).toBeUndefined();
        expect(options.sendDefaultPii).toBe(false);
        expect(options.tracesSampleRate).toBe(0);
        expect(options.beforeSend).toBe(scrubEvent);
        expect(options).not.toHaveProperty("replaysOnErrorSampleRate");
    });

    it("reads the DSN, environment, release, and sample rate", () => {
        const options = browserSentryOptions({
            dsn: " https://k@o1.ingest.sentry.io/2 ",
            environment: "staging",
            release: "mike@1.0.0",
            tracesSampleRate: "0.25",
        });
        expect(options.enabled).toBe(true);
        expect(options.dsn).toBe("https://k@o1.ingest.sentry.io/2");
        expect(options.environment).toBe("staging");
        expect(options.release).toBe("mike@1.0.0");
        expect(options.tracesSampleRate).toBe(0.25);
        expect(options.initialScope).toEqual({
            tags: {
                service: "mike-frontend",
                runtime: "browser",
                install: "community",
            },
        });
        expect(Sentry.captureConsoleIntegration).toHaveBeenCalledWith({
            levels: ["error"],
        });
    });

    it("is off with the disabled flag, and marks the official deployment", () => {
        const off = browserSentryOptions({ disabled: "true", dsn: "https://k@o1.ingest.sentry.io/2" });
        expect(off.enabled).toBe(false);
        expect(off.dsn).toBeUndefined();
        const official = browserSentryOptions({ install: "official" });
        expect((official.initialScope as { tags: { install: string } }).tags.install).toBe("official");
    });

    it("defaults the environment to self-hosted, never to NODE_ENV", () => {
        expect(browserSentryOptions({}).environment).toBe("self-hosted");
        expect(browserSentryOptions({ nodeEnv: "production" }).environment).toBe("self-hosted");
    });
});

describe("release tagging", () => {
    it("falls back to the git sha for both the browser and the server options", () => {
        expect(browserSentryOptions({ dsn: "https://k@o.ingest.sentry.io/1", gitSha: "abcdef1234567890" }).release).toBe(
            "mike@abcdef123456",
        );
        expect(
            serverSentryOptions("server", {
                NODE_ENV: "test",
                SENTRY_DSN: "https://k@o.ingest.sentry.io/1",
                GIT_SHA: "abcdef1234567890",
            } as NodeJS.ProcessEnv).release,
        ).toBe("mike@abcdef123456");
        expect(
            serverSentryOptions("server", {
                NODE_ENV: "test",
                SENTRY_RELEASE: "mike@3.1.0",
                GIT_SHA: "abcdef1234567890",
            } as NodeJS.ProcessEnv).release,
        ).toBe("mike@3.1.0");
    });
});

describe("serverSentryOptions", () => {
    it("reads runtime env and tags the runtime", () => {
        const options = serverSentryOptions("edge", {
            SENTRY_DSN: "https://k@o1.ingest.sentry.io/3",
            SENTRY_ENVIRONMENT: "prod",
            SENTRY_RELEASE: "r1",
            SENTRY_TRACES_SAMPLE_RATE: "0.1",
        } as unknown as NodeJS.ProcessEnv);
        expect(options.enabled).toBe(true);
        expect(options.environment).toBe("prod");
        expect(options.release).toBe("r1");
        expect(options.tracesSampleRate).toBe(0.1);
        expect(options.initialScope).toEqual({
            tags: { service: "mike-frontend", runtime: "edge", install: "community" },
        });
        expect(options.beforeSend).toBe(scrubEvent);
    });

    it("is ON BY DEFAULT without config, off with SENTRY_DISABLED, official only when marked", () => {
        const options = serverSentryOptions(
            "server",
            {} as unknown as NodeJS.ProcessEnv,
        );
        expect(options.enabled).toBe(true);
        expect(options.dsn).toBe(MIKE_SENTRY_DSN.frontend);
        expect(options.release).toBeUndefined();
        expect(options.environment).toBe("self-hosted");
        const withNodeEnv = serverSentryOptions("server", {
            NODE_ENV: "production",
        } as unknown as NodeJS.ProcessEnv);
        expect(withNodeEnv.environment).toBe("self-hosted");
        const off = serverSentryOptions("server", {
            SENTRY_DISABLED: "true",
        } as unknown as NodeJS.ProcessEnv);
        expect(off.enabled).toBe(false);
        const official = serverSentryOptions("server", {
            SENTRY_INSTALL: "official",
        } as unknown as NodeJS.ProcessEnv);
        expect((official.initialScope as { tags: { install: string } }).tags.install).toBe("official");
    });
});

describe("reportNetworkFailure", () => {
    it("is a no-op without a DSN but still marks the error for the console bridge", () => {
        const failure = new TypeError("Failed to fetch");
        expect(
            reportNetworkFailure(failure, { method: "GET", url: "/api/user/profile" }),
        ).toBeNull();
        expect(Sentry.captureException).not.toHaveBeenCalled();
        expect(
            scrubEvent(
                {
                    logger: "console",
                    exception: {
                        values: [{ mechanism: { type: "auto.core.capture_console" } }],
                    },
                },
                { originalException: failure },
            ),
        ).toBeNull();
    });

    it("reports a warning grouped per endpoint, not one issue for every fetch failure", () => {
        state.enabled = true;
        const failure = new TypeError("Failed to fetch");

        reportNetworkFailure(failure, {
            method: "POST",
            url: "/api/projects/8f1c2a3e-1234-4bcd-9e0f-1234567890ab/documents",
        });

        expect(Sentry.captureException).toHaveBeenCalledWith(failure);
        const scope = state.scopes[0];
        expect(scope.setLevel).toHaveBeenCalledWith("warning");
        expect(scope.setFingerprint).toHaveBeenCalledWith([
            "api-network",
            "POST",
            "/api/projects/:id/documents",
        ]);
        expect(scope.setTag).toHaveBeenCalledWith("network", true);
        expect(scope.setTag).toHaveBeenCalledWith("http_route", "/api/projects/:id/documents");
    });
});

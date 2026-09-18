import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake scope records what reportError() sets so the assertions can check
// tags/extra/level land on the event rather than on a global scope.
type FakeScope = {
  setLevel: ReturnType<typeof vi.fn>;
  setTag: ReturnType<typeof vi.fn>;
  setExtra: ReturnType<typeof vi.fn>;
  setFingerprint: ReturnType<typeof vi.fn>;
  setUser: ReturnType<typeof vi.fn>;
};

const scopes: FakeScope[] = [];
const isolationScope: FakeScope = {
  setLevel: vi.fn(),
  setTag: vi.fn(),
  setExtra: vi.fn(),
  setFingerprint: vi.fn(),
  setUser: vi.fn(),
};

const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(() => "event-id-1"),
  captureMessage: vi.fn(() => "event-id-2"),
  flush: vi.fn(() => Promise.resolve(true)),
  httpIntegration: vi.fn((opts: unknown) => ({ name: "Http", opts })),
  captureConsoleIntegration: vi.fn((opts: unknown) => ({
    name: "CaptureConsole",
    opts,
  })),
  onUnhandledRejectionIntegration: vi.fn((opts: unknown) => ({
    name: "OnUnhandledRejection",
    opts,
  })),
}));

vi.mock("@sentry/node", () => ({
  ...sentryMock,
  withScope: (cb: (scope: FakeScope) => unknown) => {
    const scope: FakeScope = {
      setLevel: vi.fn(),
      setTag: vi.fn(),
      setExtra: vi.fn(),
      setFingerprint: vi.fn(),
      setUser: vi.fn(),
    };
    scopes.push(scope);
    return cb(scope);
  },
  getIsolationScope: () => isolationScope,
}));

import * as Sentry from "@sentry/node";
import {
  bestEffort,
  MIKE_SENTRY_DSN,
  flushSentry,
  initSentry,
  redactText,
  redactUrl,
  isSentryEnabled,
  reportError,
  reportMessage,
  resetSentryForTests,
  scrubEvent,
  sentryConfiguration,
  setCurrentUser,
  tagCurrentRequest,
  withinIssueBudget,
} from "./sentry";

// Unit tests run with NODE_ENV=test, which disables reporting by design; the
// cases that exercise the enabled path opt back in explicitly.
const quietEnv = {
  NODE_ENV: "test",
  SENTRY_ALLOW_IN_TESTS: "true",
} as NodeJS.ProcessEnv;

beforeEach(() => {
  resetSentryForTests();
  scopes.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sentryConfiguration", () => {
  it("is ON BY DEFAULT: the Mike project DSN, a community install, environment self-hosted", () => {
    const config = sentryConfiguration({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.dsn).toBe(MIKE_SENTRY_DSN.backend);
    expect(config.dsnSource).toBe("default");
    expect(config.install).toBe("community");
    // NODE_ENV no longer leaks into the environment tag: a fork's
    // "production" is not ours.
    expect(config.environment).toBe("self-hosted");
    expect(config.tracesSampleRate).toBe(0);
    expect(config.release).toBeUndefined();
  });

  it("is off with SENTRY_DISABLED=true, whatever else is set", () => {
    const config = sentryConfiguration({
      SENTRY_DISABLED: "true",
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(false);
    expect(config.dsn).toBe("");
    expect(config.dsnSource).toBe("disabled");
  });

  it("uses a self-hoster's own DSN when set and marks the official deployment", () => {
    const config = sentryConfiguration({
      SENTRY_DSN: "https://key@self.example/9",
      SENTRY_INSTALL: "official",
    } as NodeJS.ProcessEnv);
    expect(config.dsn).toBe("https://key@self.example/9");
    expect(config.dsnSource).toBe("env");
    expect(config.install).toBe("official");
  });

  it("reads the DSN, environment, release, and clamps the sample rate", () => {
    const config = sentryConfiguration({
      SENTRY_DSN: " https://key@o1.ingest.sentry.io/1 ",
      SENTRY_ENVIRONMENT: "staging",
      SENTRY_RELEASE: "mike@1.2.3",
      SENTRY_TRACES_SAMPLE_RATE: "7",
    } as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.dsn).toBe("https://key@o1.ingest.sentry.io/1");
    expect(config.environment).toBe("staging");
    expect(config.release).toBe("mike@1.2.3");
    expect(config.tracesSampleRate).toBe(1);
  });

  it("never enables inside a test process unless explicitly allowed", () => {
    const dsn = "https://key@o1.ingest.sentry.io/1";
    expect(
      sentryConfiguration({ SENTRY_DSN: dsn, NODE_ENV: "test" } as NodeJS.ProcessEnv)
        .enabled,
    ).toBe(false);
    expect(
      sentryConfiguration({ SENTRY_DSN: dsn, VITEST: "true" } as NodeJS.ProcessEnv)
        .enabled,
    ).toBe(false);
    expect(
      sentryConfiguration({
        SENTRY_DSN: dsn,
        NODE_ENV: "test",
        SENTRY_ALLOW_IN_TESTS: "true",
      } as NodeJS.ProcessEnv).enabled,
    ).toBe(true);
  });

  it("reads the per-issue budget with a sane default", () => {
    expect(sentryConfiguration({} as NodeJS.ProcessEnv).maxEventsPerIssuePerMinute).toBe(10);
    expect(
      sentryConfiguration({ SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE: "3" } as NodeJS.ProcessEnv)
        .maxEventsPerIssuePerMinute,
    ).toBe(3);
    expect(
      sentryConfiguration({ SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE: "-2" } as NodeJS.ProcessEnv)
        .maxEventsPerIssuePerMinute,
    ).toBe(10);
  });

  it("derives the release from GIT_SHA when SENTRY_RELEASE is unset", () => {
    expect(
      sentryConfiguration({ ...quietEnv, GIT_SHA: "0123456789abcdef0123" } as NodeJS.ProcessEnv)
        .release,
    ).toBe("mike@0123456789ab");
    expect(
      sentryConfiguration({
        ...quietEnv,
        GIT_SHA: "0123456789abcdef0123",
        SENTRY_RELEASE: "mike@2.0.0",
      } as NodeJS.ProcessEnv).release,
    ).toBe("mike@2.0.0");
  });

  it("ignores a non-numeric sample rate", () => {
    const config = sentryConfiguration({
      SENTRY_TRACES_SAMPLE_RATE: "lots",
    } as NodeJS.ProcessEnv);
    expect(config.tracesSampleRate).toBe(0);
  });
});

describe("initSentry", () => {
  it("does nothing without a DSN so tests and OSS installs never phone home", () => {
    expect(initSentry("api", { NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSentryEnabled()).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("initialises once with PII off, body capture off, and the console bridge on", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
      SENTRY_ENVIRONMENT: "staging",
    } as NodeJS.ProcessEnv;

    expect(initSentry("worker", env)).toBe(true);
    expect(initSentry("worker", env)).toBe(true);
    expect(isSentryEnabled()).toBe(true);
    expect(Sentry.init).toHaveBeenCalledOnce();

    const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
    expect(options.sendDefaultPii).toBe(false);
    expect(options.environment).toBe("staging");
    expect(options.beforeSend).toBe(scrubEvent);
    expect(options.initialScope).toEqual({
      tags: { service: "mike-backend", role: "worker", install: "community" },
    });
    expect(sentryMock.httpIntegration).toHaveBeenCalledWith({
      maxIncomingRequestBodySize: "none",
    });
    // Crash parity: an unhandled rejection must still take the process
    // down, as it does without a DSN (Node's default), not be swallowed.
    expect(sentryMock.onUnhandledRejectionIntegration).toHaveBeenCalledWith({
      mode: "strict",
    });
    expect(sentryMock.captureConsoleIntegration).toHaveBeenCalledWith({
      levels: ["error"],
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("enabled for worker"));
    log.mockRestore();
  });
});

describe("scrubEvent", () => {
  it("strips request bodies, cookies, and credential headers", () => {
    const event = {
      request: {
        url: "https://api.example/projects",
        method: "POST",
        data: { document: "privileged contract text" },
        cookies: { session: "abc" },
        headers: {
          Authorization: "Bearer secret",
          Cookie: "session=abc",
          "content-type": "application/json",
        },
      },
      user: { id: "user-1", email: "person@example.com", ip_address: "1.2.3.4" },
      extra: {
        nested: { api_key: "k", refreshToken: "t", note: "keep" },
        list: [{ password: "p" }],
      },
      breadcrumbs: [{ message: "x", data: { cookie: "c", ok: 1 } }],
    } as unknown as Parameters<typeof scrubEvent>[0];

    const scrubbed = scrubEvent(event, {})!;

    expect(scrubbed.request).toEqual({
      url: "https://api.example/projects",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(scrubbed.user).toEqual({ id: "user-1" });
    // extra and breadcrumb data are ALLOWLISTED: a key this codebase does
    // not attach on purpose ("nested", "list", "ok") is dropped whatever it
    // holds, because a document field has no telltale name.
    expect(scrubbed.extra).toEqual({
      nested: "[Filtered]",
      list: "[Filtered]",
    });
    expect(scrubbed.breadcrumbs).toEqual([
      { message: "x", data: { cookie: "[Filtered]", ok: "[Filtered]" } },
    ]);
  });

  it("drops a user record that has no id rather than sending email alone", () => {
    const scrubbed = scrubEvent(
      { user: { email: "person@example.com" } } as Parameters<typeof scrubEvent>[0],
      {},
    )!;
    expect(scrubbed.user).toBeUndefined();
  });

  it("drops the console bridge's duplicate of an explicitly reported error", () => {
    const error = new Error("boom");
    reportError(error); // disabled → still marks the error as reported
    const consoleEvent = {
      exception: {
        values: [{ mechanism: { type: "auto.core.capture_console" } }],
      },
    } as Parameters<typeof scrubEvent>[0];

    expect(scrubEvent(consoleEvent, { originalException: error })).toBeNull();
    expect(
      scrubEvent(consoleEvent, { originalException: new Error("other") }),
    ).not.toBeNull();
  });

  it("drops a console message whose logged object wraps an already-reported error", () => {
    const error = new Error("nested");
    reportError(error);
    const event = {
      logger: "console",
      message: "[dbq] job failed [object Object]",
    } as Parameters<typeof scrubEvent>[0];

    expect(
      scrubEvent(event, {
        captureContext: {
          extra: { arguments: ["[dbq] job failed", { id: "j1", error }] },
        },
      }),
    ).toBeNull();
  });

  it("retitles a console message around an unreported nested error and groups by label", () => {
    const error = new TypeError("column does not exist");
    const event = {
      logger: "console",
      message: "[library] failed to load [object Object]",
      extra: { arguments: ["[library] failed to load", { error: "<normalised>" }] },
    } as unknown as Parameters<typeof scrubEvent>[0];

    const scrubbed = scrubEvent(event, {
      captureContext: {
        extra: { arguments: ["[library] failed to load", { error }] },
      },
    })!;

    expect(scrubbed.message).toBe(
      "[library] failed to load: TypeError: column does not exist",
    );
    expect(scrubbed.fingerprint).toEqual([
      "console",
      "[library] failed to load",
      "TypeError",
    ]);
    expect(scrubbed.extra?.error_stack).toContain("TypeError: column does not exist");
  });

  it("leaves a console message without any error in its arguments alone", () => {
    const event = {
      logger: "console",
      message: "[dbq] claim failed relation missing",
    } as Parameters<typeof scrubEvent>[0];
    const scrubbed = scrubEvent(event, {
      captureContext: { extra: { arguments: ["[dbq] claim failed", "relation missing"] } },
    })!;
    expect(scrubbed.message).toBe("[dbq] claim failed relation missing");
    expect(scrubbed.fingerprint).toBeUndefined();
  });

  it("keeps a directly captured event even if the same error was reported before", () => {
    const error = new Error("boom");
    reportError(error);
    const direct = {
      exception: { values: [{ mechanism: { type: "generic" } }] },
    } as Parameters<typeof scrubEvent>[0];
    expect(scrubEvent(direct, { originalException: error })).not.toBeNull();
  });
});

describe("per-issue flood control", () => {
  const exceptionEvent = (value: string, component = "dbq") =>
    ({
      exception: { values: [{ type: "Error", value }] },
      tags: { component },
    }) as unknown as Parameters<typeof scrubEvent>[0];

  it("lets the first ten events of an issue through per minute and drops the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
      expect(withinIssueBudget(exceptionEvent("fetch failed"), t0 + i)).toBe(true);
    }
    expect(withinIssueBudget(exceptionEvent("fetch failed"), t0 + 11)).toBe(false);
    expect(withinIssueBudget(exceptionEvent("fetch failed"), t0 + 12)).toBe(false);
    // A different issue has its own budget.
    expect(withinIssueBudget(exceptionEvent("other"), t0 + 13)).toBe(true);
    expect(withinIssueBudget(exceptionEvent("fetch failed", "upload-worker"), t0 + 14)).toBe(true);
    // The window rolls over: allowed again, and the suppression is logged once.
    expect(withinIssueBudget(exceptionEvent("fetch failed"), t0 + 60_001)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("suppressed 2 further event(s)"),
    );
    warn.mockRestore();
  });

  it("keys on the fingerprint when one is set and on the message otherwise", () => {
    const t0 = 5_000_000;
    const fingerprinted = {
      fingerprint: ["dbq-claim-failed"],
      exception: { values: [{ type: "Error", value: "a" }] },
    } as unknown as Parameters<typeof scrubEvent>[0];
    const differentValueSameFingerprint = {
      fingerprint: ["dbq-claim-failed"],
      exception: { values: [{ type: "Error", value: "b" }] },
    } as unknown as Parameters<typeof scrubEvent>[0];
    for (let i = 0; i < 10; i += 1) withinIssueBudget(fingerprinted, t0 + i);
    expect(withinIssueBudget(differentValueSameFingerprint, t0 + 20)).toBe(false);

    const message = { message: "odd state" } as Parameters<typeof scrubEvent>[0];
    for (let i = 0; i < 10; i += 1) withinIssueBudget(message, t0 + i);
    expect(withinIssueBudget(message, t0 + 20)).toBe(false);
  });

  it("is enforced by scrubEvent", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 10; i += 1) {
      expect(scrubEvent(exceptionEvent("loop"), {})).not.toBeNull();
    }
    expect(scrubEvent(exceptionEvent("loop"), {})).toBeNull();
  });

  it("honours the configured budget after init", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
      SENTRY_ALLOW_IN_TESTS: "true",
      SENTRY_MAX_EVENTS_PER_ISSUE_PER_MINUTE: "2",
    } as NodeJS.ProcessEnv);
    expect(withinIssueBudget(exceptionEvent("x"))).toBe(true);
    expect(withinIssueBudget(exceptionEvent("x"))).toBe(true);
    expect(withinIssueBudget(exceptionEvent("x"))).toBe(false);
  });
});

describe("reportError / reportMessage", () => {
  it("returns null and captures nothing while disabled", () => {
    expect(reportError(new Error("x"), { tags: { a: "b" } })).toBeNull();
    expect(reportMessage("x")).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("captures with tags, extra, level, and fingerprint on an isolated scope", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);
    const error = new Error("job exploded");

    const id = reportError(error, {
      level: "warning",
      tags: { component: "dbq", attempt: 2, skipped: undefined, gone: null },
      extra: { job_id: "j1" },
      fingerprint: ["dbq", "kind"],
    });

    expect(id).toBe("event-id-1");
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    const scope = scopes[0];
    expect(scope.setLevel).toHaveBeenCalledWith("warning");
    expect(scope.setFingerprint).toHaveBeenCalledWith(["dbq", "kind"]);
    expect(scope.setTag).toHaveBeenCalledWith("component", "dbq");
    expect(scope.setTag).toHaveBeenCalledWith("attempt", 2);
    expect(scope.setTag).not.toHaveBeenCalledWith("skipped", expect.anything());
    expect(scope.setTag).not.toHaveBeenCalledWith("gone", expect.anything());
    expect(scope.setExtra).toHaveBeenCalledWith("job_id", "j1");
  });

  it("wraps a non-Error throwable so Sentry still gets a stack", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);

    reportError({ code: "weird" });

    const captured = vi.mocked(Sentry.captureException).mock.calls[0][0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('{"code":"weird"}');
  });

  it("sends messages at the requested level", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);

    reportMessage("odd state", { level: "warning", tags: { component: "http" } });

    expect(Sentry.captureMessage).toHaveBeenCalledWith("odd state", "warning");
    expect(scopes[0].setTag).toHaveBeenCalledWith("component", "http");
  });
});

describe("request context helpers", () => {
  it("are no-ops while disabled", async () => {
    tagCurrentRequest("req-1");
    setCurrentUser("user-1");
    await flushSentry();
    expect(isolationScope.setTag).not.toHaveBeenCalled();
    expect(isolationScope.setUser).not.toHaveBeenCalled();
    expect(Sentry.flush).not.toHaveBeenCalled();
  });

  it("tag the isolation scope and flush when enabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);

    tagCurrentRequest("req-1");
    setCurrentUser("user-1");
    setCurrentUser(null);
    await flushSentry(50);

    expect(isolationScope.setTag).toHaveBeenCalledWith("request_id", "req-1");
    expect(isolationScope.setUser).toHaveBeenCalledWith({ id: "user-1" });
    expect(isolationScope.setUser).toHaveBeenLastCalledWith(null);
    expect(Sentry.flush).toHaveBeenCalledWith(50);
  });

  it("swallows a flush failure so shutdown still exits", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initSentry("api", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);
    sentryMock.flush.mockRejectedValueOnce(new Error("transport down"));
    await expect(flushSentry()).resolves.toBeUndefined();
  });
});

describe("redactUrl", () => {
  it("filters the download token path segment and keeps the rest of the path", () => {
    expect(redactUrl("/download/eyJhbGciOi.abc?inline=1")).toBe(
      "/download/[Filtered]?inline=1",
    );
    expect(redactUrl("https://api.example.com/download/tok")).toBe(
      "https://api.example.com/download/[Filtered]",
    );
  });

  it("filters OAuth callback codes, credential-looking params, and presigned signature fields", () => {
    expect(
      redactUrl("/user/oauth/callback?code=AUTH-CODE&state=STATE&provider=google"),
    ).toBe("/user/oauth/callback?code=[Filtered]&state=[Filtered]&provider=google");
    expect(
      redactUrl(
        "https://s3.local/mike/docs/a.pdf?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA%2Fus&X-Amz-Expires=60",
      ),
    ).toBe(
      "https://s3.local/mike/docs/a.pdf?X-Amz-Signature=[Filtered]&X-Amz-Credential=[Filtered]&X-Amz-Expires=60",
    );
  });

  it("leaves ordinary URLs untouched", () => {
    expect(redactUrl("/projects/8f1c/documents?limit=20&cursor=abc")).toBe(
      "/projects/8f1c/documents?limit=20&cursor=abc",
    );
  });
});

describe("scrubEvent URL hygiene", () => {
  it("redacts the request URL, the query string, url-shaped extras, and breadcrumb URLs", () => {
    const event = {
      request: {
        url: "http://localhost:3001/download/secret-token?x=1",
        query_string: "code=AUTHCODE&page=2",
        headers: {},
      },
      extra: { path: "/user/oauth/callback?code=AUTHCODE&state=S" },
      breadcrumbs: [
        {
          category: "http",
          data: {
            url: "https://s3.local/b/k?X-Amz-Signature=sig&X-Amz-Expires=60",
            method: "GET",
          },
        },
      ],
    } as unknown as Sentry.ErrorEvent;

    const out = scrubEvent(event, {})!;

    expect(out.request?.url).toBe(
      "http://localhost:3001/download/[Filtered]?x=1",
    );
    expect(out.request?.query_string).toBe("code=[Filtered]&page=2");
    expect(out.extra?.path).toBe(
      "/user/oauth/callback?code=[Filtered]&state=[Filtered]",
    );
    expect(out.breadcrumbs?.[0]?.data?.url).toBe(
      "https://s3.local/b/k?X-Amz-Signature=[Filtered]&X-Amz-Expires=60",
    );
  });

  it("filters credential keys when the SDK hands the query over as a map", () => {
    const event = {
      request: { query_string: { code: "AUTH", page: "2" } },
    } as unknown as Sentry.ErrorEvent;
    const out = scrubEvent(event, {})!;
    expect(out.request?.query_string).toEqual({ code: "[Filtered]", page: "2" });
  });
});

describe("bestEffort", () => {
  beforeEach(() => {
    resetSentryForTests();
    initSentry("worker", {
      ...quietEnv,
      SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
    } as NodeJS.ProcessEnv);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("passes a resolved value straight through and reports nothing", async () => {
    await expect(
      bestEffort(Promise.resolve(42), { what: "storage-delete:test" }),
    ).resolves.toBe(42);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("turns a rejection into a warning grouped by `what`, warns once, and resolves undefined", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("AccessDenied");

    await expect(
      bestEffort(Promise.reject(failure), {
        what: "storage-delete:copy-rollback",
        tags: { component: "storage", stage: "copy-rollback" },
      }),
    ).resolves.toBeUndefined();

    expect(Sentry.captureException).toHaveBeenCalledWith(failure);
    const scope = scopes.at(-1)!;
    expect(scope.setLevel).toHaveBeenCalledWith("warning");
    expect(scope.setFingerprint).toHaveBeenCalledWith([
      "best-effort",
      "storage-delete:copy-rollback",
    ]);
    expect(scope.setTag).toHaveBeenCalledWith("component", "storage");
    expect(scope.setTag).toHaveBeenCalledWith("stage", "copy-rollback");
    expect(scope.setTag).toHaveBeenCalledWith(
      "what",
      "storage-delete:copy-rollback",
    );
    // warn, not error: the console bridge only listens at error level, so
    // the explicit report above is the one event and this line is the log.
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("value-level redaction (due-diligence findings)", () => {
  const SECRETS = [
    "sk-ant-api03-abcdefghijklmnop",
    "Bearer eyJhbGciOi.secret.sig",
    "eyJhbGciOi.secret.sig",
    "jane.doe@bigfirm.com",
    "X-Amz-Signature=deadbeef",
    "AKIAABCDEFGHIJKLMNOP",
    "PRIVILEGED settlement",
  ];

  it("leaves none of a key, a bearer token, a JWT, an email, a signed URL, or a stray document field anywhere on the event", () => {
    const event = {
      message: "Bearer eyJhbGciOi.secret.sig for jane.doe@bigfirm.com",
      exception: {
        values: [
          {
            type: "Error",
            value:
              'duplicate key value violates unique constraint "profiles_email_key" DETAIL: Key (email)=(jane.doe@bigfirm.com) already exists. key sk-ant-api03-abcdefghijklmnop',
          },
        ],
      },
      extra: {
        presigned:
          "https://s3.example/k?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAABCDEFGHIJKLMNOP",
        doc_text: "PRIVILEGED settlement $4.2m",
        job_id: "j1",
        detail: "user jane.doe@bigfirm.com hit AKIAABCDEFGHIJKLMNOP",
        arguments: ["[x] failed", { documentId: "d1", note: "PRIVILEGED settlement" }],
      },
      contexts: { app: { note: "sk-ant-api03-abcdefghijklmnop" } },
      breadcrumbs: [
        {
          message: "user jane.doe@bigfirm.com Bearer eyJhbGciOi.secret.sig",
          data: { url: "https://x/?token=1", free: "PRIVILEGED settlement" },
        },
      ],
    } as unknown as Sentry.ErrorEvent;

    const out = JSON.stringify(scrubEvent(event, {}));

    for (const secret of SECRETS) expect(out).not.toContain(secret);
    // What must survive: the shape of the failure and the ids to find it.
    expect(out).toContain('"job_id":"j1"');
    expect(out).toContain('"documentId":"d1"');
    expect(out).toContain("profiles_email_key");
    expect(out).toContain("[email]");
  });

  it("redactText handles each secret class on its own", () => {
    expect(redactText("key sk-ant-api03-abcdefghijklmnop here")).toBe("key [api-key] here");
    expect(redactText("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [Filtered]");
    expect(redactText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")).toBe("jwt [jwt]");
    expect(redactText("mail a.b+c@d.co and https://s3/x?X-Amz-Signature=1&X-Amz-Expires=60")).toBe(
      "mail [email] and https://s3/x?X-Amz-Signature=[Filtered]&X-Amz-Expires=60",
    );
    expect(redactText("plain message with nothing in it")).toBe("plain message with nothing in it");
  });
});

describe("automatic captures of an already-reported error", () => {
  it("drops the unhandled-rejection handler's copy but keeps the explicit capture", () => {
    const failure = new Error("upstream 503");
    reportError(failure, { tags: { component: "http" } });

    const unhandledCopy = {
      exception: {
        values: [
          {
            type: "Error",
            value: "upstream 503",
            mechanism: { type: "auto.node.onunhandledrejection", handled: false },
          },
        ],
      },
    } as unknown as Sentry.ErrorEvent;
    expect(scrubEvent(unhandledCopy, { originalException: failure })).toBeNull();

    const explicitCopy = {
      exception: {
        values: [
          { type: "Error", value: "upstream 503", mechanism: { type: "generic", handled: true } },
        ],
      },
    } as unknown as Sentry.ErrorEvent;
    expect(scrubEvent(explicitCopy, { originalException: failure })).not.toBeNull();

    const unrelated = new Error("never reported");
    expect(
      scrubEvent(unhandledCopy, { originalException: unrelated }),
    ).not.toBeNull();
  });
});

describe("community install minimisation", () => {
  afterEach(() => resetSentryForTests());

  it("sends only what our code owns and what is too broad to identify anyone", () => {
    resetSentryForTests("community");
    const event = {
      server_name: "janes-macbook.local",
      user: { id: "user-1" },
      message: "ENOENT: /Users/jane/work/mike/backend/uploads/contract.pdf",
      tags: { component: "http", server_name: "janes-macbook.local", url: "https://firm.example/x" },
      request: {
        url: "https://firm.example/projects/p-1",
        method: "GET",
        headers: { host: "firm.example", "user-agent": "curl" },
      },
      contexts: {
        os: { name: "macOS", version: "26.5", kernel_version: "25.5.0", build: "25F80" },
        runtime: { name: "node", version: "v22.23.1" },
        device: { arch: "arm64", memory_size: 8 },
        culture: { locale: "en-US", timezone: "America/Los_Angeles" },
        app: { app_start_time: "2026-09-18T00:00:00Z" },
        trace: { trace_id: "abc" },
      },
      breadcrumbs: [{ message: "user clicked" }],
      extra: { job_id: "j1", error_stack: "at fn (/home/ubuntu/mike/backend/src/x.ts:3:1)" },
      exception: {
        values: [
          {
            type: "Error",
            value: "failed at /home/ubuntu/mike/backend/src/lib/x.ts and C:\\Users\\bob\\y",
            stacktrace: {
              frames: [
                {
                  filename: "/Users/jane/work/mike/node_modules/express/lib/router.js",
                  abs_path: "/Users/jane/work/mike/node_modules/express/lib/router.js",
                  in_app: false,
                  context_line: "next(err)",
                  vars: { secret: "x" },
                },
                {
                  filename: "/Users/jane/work/mike/backend/src/lib/httpError.ts",
                  abs_path: "/Users/jane/work/mike/backend/src/lib/httpError.ts",
                  in_app: true,
                  context_line: "reportError(error)",
                },
                { filename: "/opt/somewhere/else.js", in_app: false },
              ],
            },
          },
        ],
      },
    } as unknown as Sentry.ErrorEvent;

    const out = scrubEvent(event, {})!;

    expect(out.server_name).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(out.breadcrumbs).toBeUndefined();
    expect(out.tags).toEqual({ component: "http" });
    expect(out.request).toEqual({ method: "GET", url: "/projects/p-1" });
    expect(out.contexts).toEqual({
      os: { name: "macOS", version: "26.5" },
      runtime: { name: "node", version: "v22.23.1" },
      trace: { trace_id: "abc" },
    });
    expect(out.message).toBe("ENOENT: backend/uploads/contract.pdf");
    expect(out.extra).toEqual({
      job_id: "j1",
      error_stack: "at fn (backend/src/x.ts:3:1)",
    });
    const value = out.exception!.values![0]!;
    expect(value.value).toBe("failed at backend/src/lib/x.ts and [path]");
    const frames = value.stacktrace!.frames!;
    expect(frames[0]).toEqual({
      filename: "node_modules/express/lib/router.js",
      abs_path: "node_modules/express/lib/router.js",
      in_app: false,
    });
    expect(frames[1]).toEqual({
      filename: "backend/src/lib/httpError.ts",
      abs_path: "backend/src/lib/httpError.ts",
      in_app: true,
      context_line: "reportError(error)",
    });
    expect(frames[2]).toEqual({ filename: "[external]", in_app: false });
    expect(JSON.stringify(out)).not.toMatch(/jane|janes-macbook|firm\.example|ubuntu|bob|Los_Angeles/);
  });

  it("keeps the full shape on the official deployment", () => {
    resetSentryForTests("official");
    const out = scrubEvent(
      {
        server_name: "api-1",
        user: { id: "user-1" },
        breadcrumbs: [{ message: "x" }],
      } as unknown as Sentry.ErrorEvent,
      {},
    )!;
    expect(out.server_name).toBe("api-1");
    expect(out.user).toEqual({ id: "user-1" });
    expect(out.breadcrumbs).toHaveLength(1);
  });
});

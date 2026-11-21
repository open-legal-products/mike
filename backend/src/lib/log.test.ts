// The entrypoint bootstrap: what every backend process loads first.
import "../instrument";
import { formatWithOptions } from "node:util";
import type { APICallError as ApiCallErrorClass } from "ai" with {
  "resolution-mode": "import",
};
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppError } from "./appError";
import { jobErrorMessage } from "./dbq/jobError";
import { countMetric, log, logError, logEvent, redactedProviderError, setLogForwarder, tpl } from "./log";
import { reportModelFailure } from "./llm/providerFailureReport";

// What a lawyer's prompt looks like on the way to a provider: document text
// inside the request body, echoed back in the provider's response body.
const SENTINEL = "PRIVILEGED-DOC-TEXT-7f3a";

// The AI SDK is ESM-only; this CommonJS test loads it the way the backend does.
let APICallError: typeof ApiCallErrorClass;
beforeAll(async () => {
  ({ APICallError } = await import("ai"));
});

function providerError() {
  const body = {
    type: "error",
    error: { type: "invalid_request_error", message: `bad ${SENTINEL}-response` },
  };
  return new APICallError({
    message: `Bad request: ${SENTINEL}-message`,
    url: `https://api.example.com/v1/messages?key=${SENTINEL}-url`,
    requestBodyValues: {
      model: "claude",
      input: `${SENTINEL}-input`,
      messages: [{ role: "user", content: `Summarise: ${SENTINEL}-request` }],
    },
    statusCode: 400,
    responseHeaders: { "x-request-id": `${SENTINEL}-header` },
    responseBody: JSON.stringify(body),
    isRetryable: false,
    // The provider adapter's parse of the response body.
    data: body,
  });
}

/** Exactly the text Node's console would write for the captured calls. */
function captured(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((args) => formatWithOptions({ colors: false }, ...args))
    .join("\n");
}

describe("error logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never writes a provider error's request, response, headers or URL", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("chat", providerError());
    const out = captured(spy);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("AI provider error");
    expect(out).toContain("400");
    expect(out).toContain("invalid_request_error");
  });

  it("redacts an ordinary cause inside an SDK error", async () => {
    const { JSONParseError } = await import("ai");
    const failure = new JSONParseError({
      text: "malformed output",
      cause: new SyntaxError(SENTINEL),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("chat", failure);
    const out = captured(spy);
    expect(out).toContain("AI provider error AI_JSONParseError");
    expect(out).not.toContain(SENTINEL);
  });

  it("names the SDK class but never a name that is not a class name", () => {
    const failure = providerError();
    expect(redactedProviderError(failure)).toMatch(/^AI provider error AI_APICallError /);
    failure.name = `${SENTINEL} prompt text`;
    const out = redactedProviderError(failure);
    expect(out).toMatch(/^AI provider error \{/);
    expect(out).not.toContain(SENTINEL);
  });

  it("leaves values that are not provider errors to normal formatting", () => {
    expect(redactedProviderError(new Error("plain"))).toBeUndefined();
    expect(redactedProviderError({ message: "plain" })).toBeUndefined();
    expect(redactedProviderError(null)).toBeUndefined();
    expect(redactedProviderError("text")).toBeUndefined();
  });

  it("never writes a provider error nested as the cause of an AppError", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new AppError("provider-rejected", "Model stream failed", {
      cause: providerError(),
    });
    logError("chat", failure);
    reportModelFailure(failure, {}, "[chat/stream] model stream failed");
    const out = captured(spy);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("AppError");
    expect(out).toContain("provider-rejected");
    expect(out).toContain("AI provider error");
    expect(out).toContain("log.test.ts");
  });

  it("keeps an ordinary error's message and stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("jobs", new Error("queue row 42 missing"), { jobId: "j1" });
    const out = captured(spy);
    expect(out).toContain("[jobs]");
    expect(out).toContain("queue row 42 missing");
    expect(out).toContain("log.test.ts");
    expect(out).toContain("j1");
  });
});

describe("job error messages", () => {
  it("never records a provider error's text as a job's last_error", () => {
    const message = jobErrorMessage(providerError());
    expect(message).not.toContain(SENTINEL);
    expect(message).toContain("AI provider error AI_APICallError");
    expect(message).toContain("invalid_request_error");
  });

  it("keeps the reason for every other failure", () => {
    expect(jobErrorMessage(new Error("queue row 42 missing"))).toBe("queue row 42 missing");
    expect(jobErrorMessage({ message: "permission denied", code: "42501" })).toBe("permission denied");
    expect(jobErrorMessage(undefined, "cleanup_failed")).toBe("cleanup_failed");
  });
});

describe("the central logger", () => {
  afterEach(() => {
    setLogForwarder(null);
    vi.restoreAllMocks();
  });

  function forwarded() {
    const logs: unknown[][] = [];
    const metrics: unknown[][] = [];
    setLogForwarder({
      log: (...args) => void logs.push(args),
      metric: (...args) => void metrics.push(args),
    });
    return { logs, metrics };
  }

  it("prints what console.warn printed and forwards only the scope and message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logs } = forwarded();
    const error = new Error("a client's words");
    log.warn("dbq", "poll failed", error, { path: "/matters/Smith" });
    expect(warn).toHaveBeenCalledWith("[dbq] poll failed", error, { path: "/matters/Smith" });
    expect(logs).toEqual([["warn", "[dbq] poll failed", {}]]);
  });

  it("prints a templated line whole and forwards its source text with the values left out", () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logs } = forwarded();
    log.info(tpl`[router-models] user ${"u-123"} requested ${"gpt"} outside their selection`, "extra");
    expect(print).toHaveBeenCalledWith("[router-models] user u-123 requested gpt outside their selection", "extra");
    expect(logs).toEqual([["info", "[router-models] user {} requested {} outside their selection", {}]]);
  });

  it("prints and forwards a structured event's attributes, and counts a metric", () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logs, metrics } = forwarded();
    logEvent("info", "tool-activity", "counted", { tool: "read_document", count: 2 }, "detail");
    countMetric("tool_activity", 2, { tool: "read_document" });
    expect(print).toHaveBeenCalledWith("[tool-activity] counted", { tool: "read_document", count: 2 }, "detail");
    expect(logs).toEqual([["info", "[tool-activity] counted", { tool: "read_document", count: 2 }]]);
    expect(metrics).toEqual([["tool_activity", 2, { tool: "read_document" }]]);
  });

  it("only prints without a forwarder, and survives one that throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.warn("dbq", "poll failed");
    setLogForwarder({
      log: () => {
        throw new Error("sdk");
      },
      metric: () => {
        throw new Error("sdk");
      },
    });
    expect(() => log.warn("dbq", "poll failed")).not.toThrow();
    expect(() => countMetric("tool_activity", 1)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

// The entrypoint bootstrap: what every backend process loads first.
import "../instrument";
import { formatWithOptions } from "node:util";
import type { APICallError as ApiCallErrorClass } from "ai" with {
  "resolution-mode": "import",
};
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppError } from "./appError";
import { logError } from "./log";
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
    message: "Bad Request",
    url: `https://api.example.com/v1/messages?key=${SENTINEL}-url`,
    requestBodyValues: {
      model: "claude",
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
    expect(out).toContain("AI_APICallError");
    expect(out).toContain("400");
    expect(out).toContain("invalid_request_error");
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
    // Still debuggable: both classes in the chain, the kind, and the stack.
    expect(out).toContain("AppError");
    expect(out).toContain("provider-rejected");
    expect(out).toContain("AI_APICallError");
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

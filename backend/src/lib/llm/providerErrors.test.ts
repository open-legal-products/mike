import { describe, expect, it } from "vitest";
import { AppError } from "../appError";
import { diagnosticErrorTags } from "../observability/sentryPrivacy";
import { UserFacingError } from "../userFacingError";
import { InvalidApiKeyError } from "./apiKeyErrors";
import {
  asProviderStallError,
  providerFailureKind,
  toProviderStreamError,
} from "./providerErrors";

const gemini = { label: "Gemini", modelId: "gemini-2.5-pro" };

function apiCallError(statusCode: number, responseBody = "") {
  return Object.assign(new Error(`Request failed (${statusCode})`), {
    name: "AI_APICallError",
    statusCode,
    responseBody,
  });
}

describe("toProviderStreamError", () => {
  it.each([401, 402, 403, 404, 429])("retains the original %i provider failure internally", (status) => {
    const original = apiCallError(status, "private provider response");
    const error = toProviderStreamError(original, gemini);
    expect(error.cause).toBe(original);
    expect(error.message).not.toContain("private provider response");
    expect(JSON.stringify(error)).not.toContain("private provider response");
  });

  it("explains a free-tier key without access to the model", () => {
    const error = toProviderStreamError(
      apiCallError(
        429,
        '{"error":{"code":429,"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-2.5-pro","status":"RESOURCE_EXHAUSTED"}}',
      ),
      gemini,
    );

    expect(error).toBeInstanceOf(UserFacingError);
    expect(error.message).toBe(
      "The Gemini plan doesn't include gemini-2.5-pro. Select another model, or upgrade the Gemini plan.",
    );
  });

  it("unwraps the last error from an AI SDK retry error", () => {
    const retryError = Object.assign(new Error("Failed after 3 attempts"), {
      name: "AI_RetryError",
      lastError: apiCallError(429, "Resource has been exhausted"),
    });

    const error = toProviderStreamError(retryError, gemini);

    expect(error).toBeInstanceOf(UserFacingError);
    expect(error.message).toBe(
      "Gemini rate limit or quota reached. Wait a moment and try again, or select another model.",
    );
  });

  it("treats a 403 naming the key as a rejected key, not a missing model", () => {
    const error = toProviderStreamError(
      apiCallError(403, '{"error":{"message":"API key expired."}}'),
      gemini,
    );

    expect(error).toBeInstanceOf(InvalidApiKeyError);
  });

  it("explains a key rejection hidden inside a retry error", () => {
    const retryError = Object.assign(new Error("Failed after 3 attempts"), {
      name: "AI_RetryError",
      lastError: apiCallError(401),
    });

    expect(toProviderStreamError(retryError, gemini)).toBeInstanceOf(
      InvalidApiKeyError,
    );
  });

  it.each([403, 404])("explains a %i as the model being unavailable", (status) => {
    const error = toProviderStreamError(apiCallError(status), gemini);

    expect(error).toBeInstanceOf(UserFacingError);
    expect(error.message).toBe(
      "gemini-2.5-pro isn't available with the Gemini API key. Select another model.",
    );
  });

  it("explains a rejected API key", () => {
    const error = toProviderStreamError(
      apiCallError(
        400,
        '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
      ),
      gemini,
    );

    expect(error).toBeInstanceOf(InvalidApiKeyError);
  });

  it("keeps unclassified failures internal", () => {
    const original = apiCallError(500, "backend exploded");

    const error = toProviderStreamError(original, gemini);

    expect(error).not.toBeInstanceOf(UserFacingError);
    expect(error.message).toBe("Request failed (500)");
  });

  it("wraps non-Error values", () => {
    const error = toProviderStreamError(undefined, gemini);

    expect(error).not.toBeInstanceOf(UserFacingError);
    expect(error.message).toBe("Gemini stream failed.");
  });
});

describe("asProviderStallError", () => {
  const ctx = { label: "Mock", modelId: "m" };
  it("recognises the SDK chunk timeouts", () => {
    for (const reason of [
      "TimeoutError: Chunk timeout of 60000ms exceeded",
      new DOMException("First chunk timeout of 120000ms exceeded", "TimeoutError"),
    ]) {
      expect(asProviderStallError(reason, ctx)?.message).toMatch(/stopped responding/);
    }
  });
  it("ignores everything else", () => {
    expect(asProviderStallError("Stream aborted.", ctx)).toBeNull();
    expect(asProviderStallError(new Error("boom"), ctx)).toBeNull();
    expect(asProviderStallError(undefined, ctx)).toBeNull();
  });
});

describe("providerFailureKind", () => {
  it.each([
    [401, "chat.provider_rejected"],
    [403, "chat.provider_rejected"],
    [429, "chat.provider_rate_limited"],
    [500, "chat.provider_unavailable"],
    [503, "chat.provider_unavailable"],
    [402, "chat.stream_failed"],
    [404, "chat.stream_failed"],
  ] as const)("maps a provider %i to %s", (status, kind) => {
    expect(providerFailureKind(apiCallError(status))).toBe(kind);
  });

  it("classifies the error toProviderStreamError returns the same as its API error", () => {
    const wrapped = toProviderStreamError(apiCallError(429), gemini);
    expect(wrapped).toBeInstanceOf(UserFacingError);
    expect(providerFailureKind(wrapped)).toBe("chat.provider_rate_limited");
  });

  it("classifies a stalled stream as unavailable whatever wraps it", () => {
    const stall = new Error("first chunk timeout of 30000ms exceeded");
    expect(providerFailureKind(stall)).toBe("chat.provider_unavailable");
    expect(providerFailureKind(toProviderStreamError(stall, gemini))).toBe("chat.provider_unavailable");
    expect(providerFailureKind(new Error("turn failed", { cause: stall }))).toBe("chat.provider_unavailable");
  });

  it("names a rejected key whatever wraps it", () => {
    const rejected = new InvalidApiKeyError("Gemini");
    expect(providerFailureKind(rejected)).toBe("chat.provider_rejected");
    expect(providerFailureKind(new Error("outer", { cause: rejected }))).toBe(
      "chat.provider_rejected",
    );
  });

  it("treats a stalled stream or an unreachable provider as unavailable", () => {
    expect(
      providerFailureKind(new Error("first chunk timeout of 30000ms exceeded")),
    ).toBe("chat.provider_unavailable");
    expect(
      providerFailureKind(
        new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }),
      ),
    ).toBe("chat.provider_unavailable");
  });

  it("falls back to the generic stream failure", () => {
    expect(providerFailureKind(new Error("something else"))).toBe("chat.stream_failed");
    expect(providerFailureKind(undefined)).toBe("chat.stream_failed");
  });
});

describe("a classified provider failure at the privacy boundary", () => {
  it("carries the kind, the provider's status and its error class, never its text", () => {
    const original = apiCallError(429, "private provider response");
    const wrapped = toProviderStreamError(original, gemini);
    const failure = new AppError(providerFailureKind(wrapped), "Model stream failed", {
      cause: wrapped,
    });

    const tags = diagnosticErrorTags(failure);

    expect(tags).toMatchObject({
      error_kind: "chat.provider_rate_limited",
      dependency_status: 429,
      provider_error: "api_call",
    });
    expect(JSON.stringify(tags)).not.toContain("private provider response");
  });
});

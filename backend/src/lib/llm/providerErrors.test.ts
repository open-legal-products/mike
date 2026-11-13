import { describe, expect, it } from "vitest";
import { AppError } from "../appError";
import { diagnosticErrorTags } from "../observability/sentryPrivacy";
import { UserFacingError } from "../userFacingError";
import { InvalidApiKeyError } from "./apiKeyErrors";
import {
  asProviderStallError,
  ProviderConfigurationError,
  isDeterministicProviderQuota,
  isUserProviderRefusal,
  providerFailureKind,
  providerFailureResponse,
  providerFailureStatus,
  providerFailureLevel,
  toProviderStreamError,
  withKeySource,
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
  it.each([401, 402, 429])("retains the original %i provider failure internally", (status) => {
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
    const error = toProviderStreamError(apiCallError(status, '{"error":{"code":"model_not_found"}}'), gemini);

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
    [403, "chat.stream_failed"],
    [429, "chat.provider_rate_limited"],
    [500, "chat.provider_unavailable"],
    [503, "chat.provider_unavailable"],
    // OpenRouter's "out of credits": the account's state, not our failure.
    [402, "chat.provider_out_of_credits"],
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

  it("finds a dropped socket under the AI SDK's exhausted retries", () => {
    // MIKE-BACKEND-88: RetryError → lastError APICallError (no status: the
    // request never got an answer) → TypeError("terminated") → undici's
    // SocketError. The socket sits on `lastError`, not `cause`.
    const socket = Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    });
    const fetchFailure = Object.assign(
      new Error("Cannot connect to API: terminated", {
        cause: new TypeError("terminated", { cause: socket }),
      }),
      { name: "AI_APICallError" },
    );
    const retried = Object.assign(new Error("Failed after 3 attempts."), {
      name: "AI_RetryError",
      lastError: fetchFailure,
      errors: [fetchFailure],
    });
    expect(providerFailureKind(fetchFailure)).toBe("chat.provider_unavailable");
    expect(providerFailureKind(retried)).toBe("chat.provider_unavailable");
  });

  it("falls back to the generic stream failure", () => {
    expect(providerFailureKind(new Error("something else"))).toBe("chat.stream_failed");
    expect(providerFailureKind(undefined)).toBe("chat.stream_failed");
  });
});

describe("providerFailureLevel", () => {
  // MIK-89: nothing in Mike can fix a user's exhausted quota or a provider
  // outage, so those are warnings; the account's own state (a rejected key,
  // no credit) is not reported at all; an unexplained failure stays an error.
  it.each([
    ["a rate limit", apiCallError(429), "warning"],
    ["an exhausted retry of a rate limit", Object.assign(new Error("Failed after 3 attempts."), { name: "AI_RetryError", lastError: apiCallError(429) }), "warning"],
    ["an outage", apiCallError(503), "warning"],
    ["a stalled stream", new Error("first chunk timeout of 30000ms exceeded"), "warning"],
    ["an unreachable provider", new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNRESET" }) }), "warning"],
    ["a body that stopped mid-stream", new TypeError("terminated", { cause: Object.assign(new Error("Body Timeout Error"), { name: "BodyTimeoutError", code: "UND_ERR_BODY_TIMEOUT" }) }), "warning"],
    ["a rejected key", new InvalidApiKeyError("Anthropic"), "error"],
    ["a forbidden model", apiCallError(403), "error"],
    ["an account out of credits", apiCallError(402), "error"],
    ["an unexplained 400", apiCallError(400), "error"],
    ["an unexplained failure", new Error("something else"), "error"],
  ] as const)("reports %s at %s", (_name, error, level) => {
    expect(providerFailureLevel(error)).toBe(level);
  });

  // Shared credentials can fail users who cannot repair them. Only a
  // proven personal credential refusal is eligible for interactive handling.
  it.each([
    ["a rejected key", () => toProviderStreamError(apiCallError(401), gemini)],
    ["a forbidden model", () => toProviderStreamError(apiCallError(403, '{"error":{"code":"model_not_found"}}'), gemini)],
    ["an account out of credits", () => toProviderStreamError(apiCallError(402), gemini)],
  ])("keeps %s visible when ownership is unknown or shared", (_name, refusal) => {
    const deployment = toProviderStreamError(refusal(), { ...gemini, keySource: "deployment" });
    const org = toProviderStreamError(refusal(), { ...gemini, keySource: "org" });
    const user = toProviderStreamError(refusal(), { ...gemini, keySource: "user" });
    expect(providerFailureLevel(deployment)).toBe("error");
    expect(providerFailureLevel(org)).toBe("error");
    expect(isUserProviderRefusal(org)).toBe(false);
    expect(isUserProviderRefusal(new AppError("chat.provider_rejected", "Model stream failed", { cause: org }))).toBe(false);
    expect(providerFailureLevel(user)).toBe("warning");
    expect(providerFailureLevel(refusal())).toBe("error");
    // Through the flow's own wrapper, as chat and tabular report it.
    expect(
      providerFailureLevel(new AppError("chat.provider_rejected", "Model stream failed", { cause: deployment })),
    ).toBe("error");
  });

  it("records the key source on a raw provider error without serializing it", () => {
    const raw = withKeySource(apiCallError(401), "deployment");
    expect(providerFailureLevel(raw)).toBe("error");
    expect(Object.keys(raw)).not.toContain("keySource");
    expect(JSON.stringify(raw)).not.toContain("deployment");
    // A later conversion keeps the first answer.
    expect(providerFailureLevel(withKeySource(raw, "user"))).toBe("error");
  });

  it("does not raise a busy provider's level for the deployment's key", () => {
    expect(providerFailureLevel(withKeySource(apiCallError(503), "deployment"))).toBe("warning");
    expect(providerFailureLevel(withKeySource(apiCallError(400), "deployment"))).toBe("error");
  });

  it("reads the condition through the AppError that names the flow", () => {
    const failure = new AppError("tabular.generation_failed", "Tabular cell completion failed", {
      cause: apiCallError(429),
    });
    expect(providerFailureLevel(failure)).toBe("warning");
    expect(
      providerFailureLevel(new AppError("chat.stream_failed", "Model stream failed", { cause: new Error("bug") })),
    ).toBe("error");
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


describe("provider failure traversal", () => {
  it("uses the same wrapped retry response for status, body and kind", () => {
    const response = apiCallError(429, "quota");
    const retry = Object.assign(new Error("retry"), { lastError: new Error("wrapper", { cause: response }) });
    const error = new Error("outer", { cause: retry });
    expect(providerFailureStatus(error)).toBe(429);
    expect(providerFailureResponse(error)).toEqual({ status: 429, body: "quota" });
    expect(providerFailureKind(error)).toBe("chat.provider_rate_limited");
  });

  it("terminates cyclic cause and retry chains", () => {
    const error = Object.assign(new Error("cycle"), { lastError: null as unknown });
    error.lastError = error;
    error.cause = error;
    expect(providerFailureStatus(error)).toBeNull();
    expect(providerFailureResponse(error)).toBeNull();
    expect(providerFailureKind(error)).toBe("chat.stream_failed");
  });
});


describe("source-owned provider refusals", () => {
  it.each([
    [403, "PRIVATE_WAF_BLOCK"],
    [404, "PRIVATE_WAF_BLOCK"],
    // A not_found_error that does not name a model is some other missing resource.
    [404, '{"type":"error","error":{"type":"not_found_error","message":"PRIVATE_FILE was not found"}}'],
    [403, '{"error":{"code":403,"message":"User location is not supported for the API use.","status":"PERMISSION_DENIED"}}'],
    // A wrong base URL: "models" is a path segment here, not a verdict.
    [404, '{"error":"Route /v1/models/chat not found"}'],
    [404, "Cannot POST /api/v1/models/messages: not found"],
  ] as const)("keeps an opaque %s visible even with a personal key (%s)", (status, body) => {
    const original = apiCallError(status, body);
    const error = toProviderStreamError(original, { ...gemini, keySource: "user" });
    expect(error).toBe(original);
    expect(error).not.toBeInstanceOf(UserFacingError);
    expect(isUserProviderRefusal(error)).toBe(false);
    expect(providerFailureLevel(error)).toBe("error");
  });
  it.each([403, 404])("handles a proven personal model-access %s refusal", status => {
    const error = toProviderStreamError(apiCallError(status, '{"error":{"code":"model_not_found","message":"PRIVATE_MODEL"}}'), { ...gemini, keySource: "user" });
    expect(error).toBeInstanceOf(UserFacingError);
    expect(isUserProviderRefusal(error)).toBe(true);
    expect(error.message).not.toContain("PRIVATE_MODEL");
  });
  it.each([
    ['{"error":{"code":"insufficient_quota"}}', "chat.provider_out_of_credits", /Top up/],
    ['{"error":{"type":"insufficient_quota"}}', "chat.provider_out_of_credits", /Top up/],
    ['Quota exceeded, limit: 0, model: example', "chat.provider_rejected", /upgrade/],
  ])("classifies deterministic quota %s before retries", (body, kind, remedy) => {
    const original = apiCallError(429, body as string);
    const personal = toProviderStreamError(original, { ...gemini, keySource: "user" });
    expect(isDeterministicProviderQuota(original)).toBe(true);
    expect(providerFailureKind(personal)).toBe(kind);
    expect(personal.message).toMatch(remedy as RegExp);
    expect(isUserProviderRefusal(personal)).toBe(true);
    const deployment = toProviderStreamError(apiCallError(429, body as string), { ...gemini, keySource: "deployment" });
    expect(providerFailureLevel(deployment)).toBe("error");
  });
  it.each([
    [403, "Your organization does not have access to this model"],
    [404, "models/gemini-private is not found for API version v1beta"],
    [404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-private"}}'],
    [404, '{"object":"error","message":"Invalid model: mistral-private","type":"invalid_model"}'],
    [404, '{"error":{"code":"DeploymentNotFound","message":"The API deployment for this resource does not exist."}}'],
    [404, '{"error":{"message":"No endpoints found for acme/private-model.","code":404}}'],
  ] as const)("recognizes a provider's model-access verdict %s", (status, body) => {
    const error = toProviderStreamError(apiCallError(status, body), { ...gemini, keySource: "user" });
    expect(isUserProviderRefusal(error)).toBe(true);
    expect(error).toBeInstanceOf(UserFacingError);
  });
  it("leaves ordinary throttling retryable and keeps setup errors at warning", () => {
    expect(isDeterministicProviderQuota(apiCallError(429, "Rate limit exceeded"))).toBe(false);
    expect(isDeterministicProviderQuota(apiCallError(429, "Quota exceeded, limit: 0.5"))).toBe(false);
    expect(isDeterministicProviderQuota(apiCallError(429, "unrelated input limit: 0"))).toBe(false);
    const setup = new ProviderConfigurationError("Add your key in Settings");
    expect(providerFailureLevel(new AppError("chat.stream_failed", "failed", { cause: setup }))).toBe("warning");
    expect(providerFailureLevel(new UserFacingError("some other failure"))).toBe("error");
  });
});

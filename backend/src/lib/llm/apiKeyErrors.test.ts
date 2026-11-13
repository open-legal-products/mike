import { describe, expect, it } from "vitest";
import {
  asInvalidApiKeyError,
  InvalidApiKeyError,
  isInvalidApiKeyError,
} from "./apiKeyErrors";

/** Shaped like the AI SDK's APICallError, which is what reaches us. */
function apiCallError(fields: {
  message?: string;
  statusCode?: number;
  responseBody?: string;
  data?: unknown;
}) {
  return Object.assign(new Error(fields.message ?? "request failed"), fields);
}

describe("isInvalidApiKeyError", () => {
  it("classifies Anthropic's 401 on a bad key", () => {
    // Observed: POST /v1/messages -> 401 invalid x-api-key
    expect(
      isInvalidApiKeyError(
        apiCallError({
          message: "invalid x-api-key",
          statusCode: 401,
          data: {
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          },
        }),
      ),
    ).toBe(true);
  });

  it("classifies Gemini's 400 on a bad key", () => {
    // Gemini reports a bad key as INVALID_ARGUMENT rather than 401, so the
    // status code alone is not enough to tell it from a malformed request.
    expect(
      isInvalidApiKeyError(
        apiCallError({
          message: "API key not valid. Please pass a valid API key.",
          statusCode: 400,
          data: {
            error: {
              code: 400,
              message: "API key not valid. Please pass a valid API key.",
              status: "INVALID_ARGUMENT",
              details: [{ reason: "API_KEY_INVALID" }],
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it("classifies OpenAI's 401 on a bad key", () => {
    expect(
      isInvalidApiKeyError(
        apiCallError({
          message: "Incorrect API key provided: sk-abc***",
          statusCode: 401,
          data: { error: { code: "invalid_api_key" } },
        }),
      ),
    ).toBe(true);
  });

  it("reads the raw body when the error carries no parsed data", () => {
    expect(
      isInvalidApiKeyError(
        apiCallError({
          message: "Bad Request",
          statusCode: 400,
          responseBody: '{"error":{"reason":"API_KEY_INVALID"}}',
        }),
      ),
    ).toBe(true);
  });

  it("leaves an ordinary 400 alone", () => {
    // Telling someone to check a working key sends them down the wrong path,
    // so a 400 has to actually name the key.
    expect(
      isInvalidApiKeyError(
        apiCallError({
          message:
            "Invalid value for 'effort': supported values are: 'low', 'high'",
          statusCode: 400,
        }),
      ),
    ).toBe(false);
  });

  it("leaves a 403 that is about model access alone", () => {
    expect(
      isInvalidApiKeyError(
        apiCallError({
          message: "Your organization does not have access to this model",
          statusCode: 403,
        }),
      ),
    ).toBe(false);
  });

  it.each(["Unauthorized", "authentication_error", "invalid_authentication"])("does not mistake an opaque 403 %s for a rejected credential", (message) => {
    expect(isInvalidApiKeyError(apiCallError({ statusCode: 403, message }))).toBe(false);
  });

  it("leaves rate limits and server failures alone", () => {
    expect(
      isInvalidApiKeyError(
        apiCallError({ message: "rate limit exceeded", statusCode: 429 }),
      ),
    ).toBe(false);
    expect(
      isInvalidApiKeyError(
        apiCallError({ message: "internal error", statusCode: 500 }),
      ),
    ).toBe(false);
  });

  it("ignores key-shaped text without an auth status code", () => {
    // A model talking about API keys in its own output must not be mistaken
    // for the provider rejecting ours.
    expect(
      isInvalidApiKeyError(
        apiCallError({
          message: "The contract says the api key is invalid after termination",
          statusCode: 200,
        }),
      ),
    ).toBe(false);
  });

  it("tolerates non-error values", () => {
    expect(isInvalidApiKeyError(undefined)).toBe(false);
    expect(isInvalidApiKeyError("invalid api key")).toBe(false);
    expect(isInvalidApiKeyError({})).toBe(false);
  });
});

describe("asInvalidApiKeyError", () => {
  it("names the provider and points at settings, not at the provider's text", () => {
    const mapped = asInvalidApiKeyError(
      apiCallError({ message: "invalid x-api-key", statusCode: 401 }),
      "Anthropic",
    );

    expect(mapped).toBeInstanceOf(InvalidApiKeyError);
    expect(mapped?.message).toContain("Anthropic");
    expect(mapped?.message).toContain("Settings");
    expect(mapped?.message).not.toContain("x-api-key");
  });

  it("returns null for failures the key did not cause", () => {
    expect(
      asInvalidApiKeyError(
        apiCallError({ message: "rate limit exceeded", statusCode: 429 }),
        "Anthropic",
      ),
    ).toBeNull();
  });
});

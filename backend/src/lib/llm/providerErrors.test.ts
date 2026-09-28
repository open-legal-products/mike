import { describe, expect, it } from "vitest";
import { UserFacingError } from "../userFacingError";
import { InvalidApiKeyError } from "./apiKeyErrors";
import { toProviderStreamError } from "./providerErrors";

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

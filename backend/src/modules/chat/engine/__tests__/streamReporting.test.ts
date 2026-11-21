import { afterEach, describe, expect, it } from "vitest";
import { assistantStreamErrorPayload, AssistantStreamError, ASSISTANT_ERROR_MESSAGE } from "../streaming";
import { markErrorHandled, reportError, resetSentryForTests } from "../../../../lib/observability/sentry";
import { BACKEND_REPORTING_OWNER } from "../../../../lib/reportedUpstreamCodes";
import { toProviderStreamError } from "../../../../lib/llm/providerErrors";

afterEach(() => resetSentryForTests());
describe("terminal stream reporting ownership", () => {
  it("leaves an unreported terminal exception unowned", () => {
    expect(assistantStreamErrorPayload(new Error("private payload"))).toEqual({ message: ASSISTANT_ERROR_MESSAGE });
  });
  it("preserves an explicit report through wrappers, even with telemetry disabled", () => {
    resetSentryForTests();
    const original = new Error("private original");
    reportError(original);
    expect(assistantStreamErrorPayload(new Error("wrapper", { cause: original }))).toEqual({
      message: ASSISTANT_ERROR_MESSAGE, reporting_owner: BACKEND_REPORTING_OWNER,
    });
  });
  it("does not infer ownership from a recognized safe code", () => {
    const failure = new AssistantStreamError("private", "", [{
      type: "error", message: "Update your API key.", safe_to_display: true, code: "invalid_api_key",
    }]);
    expect(assistantStreamErrorPayload(failure, "request-1")).toEqual({
      message: "Update your API key.", safe_to_display: true, code: "invalid_api_key", request_id: "request-1",
    });
  });
  it("tells whoever owns an out-of-credits key to fix it, and names only theirs as self-service", () => {
    const outOfCredits = (keySource: "user" | "org" | "deployment") =>
      assistantStreamErrorPayload(toProviderStreamError(
        Object.assign(new Error("Request failed (402)"), { statusCode: 402, responseBody: "PRIVATE_BILLING" }),
        { label: "Claude", modelId: "claude-sonnet-4-5", keySource },
      ));
    expect(outOfCredits("user")).toEqual({
      message: "Your Claude account is out of credits. Add credits to it, or change the key in Settings → Bring Your Own Keys.",
      safe_to_display: true, code: "provider_account_refused",
    });
    expect(outOfCredits("org")).toEqual({
      message: "Your organization's Claude account is out of credits. Ask an organization admin to add credits or change the key.",
      safe_to_display: true, code: "provider_account_refused",
    });
    // The deployment's key is ours: no self-service code, so support stays offered.
    expect(outOfCredits("deployment")).toEqual({
      message: "The Claude account this server uses is out of credits. Select another model, or contact support.",
      safe_to_display: true,
    });
  });
  it("keeps correlation and ownership when the source handled the user refusal", () => {
    const original = new Error("private original");
    markErrorHandled(original);
    const failure = new AssistantStreamError("private", "", [{
      type: "error", message: "Update your API key.", safe_to_display: true, code: "invalid_api_key",
    }], { cause: original });
    expect(assistantStreamErrorPayload(failure, "request-1")).toEqual({
      message: "Update your API key.", safe_to_display: true, code: "invalid_api_key",
      request_id: "request-1", reporting_owner: BACKEND_REPORTING_OWNER,
    });
  });
});

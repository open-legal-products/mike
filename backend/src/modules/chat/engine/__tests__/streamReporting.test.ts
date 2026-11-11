import { afterEach, describe, expect, it } from "vitest";
import { assistantStreamErrorPayload, AssistantStreamError, ASSISTANT_ERROR_MESSAGE } from "../streaming";
import { markErrorHandled, reportError, resetSentryForTests } from "../../../../lib/observability/sentry";
import { BACKEND_REPORTING_OWNER } from "../../../../lib/reportedUpstreamCodes";

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

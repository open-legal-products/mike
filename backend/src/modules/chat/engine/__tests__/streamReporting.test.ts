import { describe, expect, it } from "vitest";
import { assistantStreamErrorPayload, AssistantStreamError, ASSISTANT_ERROR_MESSAGE } from "../streaming";

describe("terminal stream reporting ownership", () => {
  it("assigns reporting to the backend without requiring a request id", () => {
    expect(assistantStreamErrorPayload(new Error("private payload"))).toEqual({
      message: ASSISTANT_ERROR_MESSAGE, reporting_owner: "backend",
    });
  });
  it("keeps correlation and the user-safe configuration refusal", () => {
    const failure = new AssistantStreamError("private", "", [{
      type: "error", message: "Update your API key.", safe_to_display: true, code: "invalid_api_key",
    }]);
    expect(assistantStreamErrorPayload(failure, "request-1")).toEqual({
      message: "Update your API key.", safe_to_display: true, code: "invalid_api_key",
      request_id: "request-1", reporting_owner: "backend",
    });
  });
});

import { describe, expect, it } from "vitest";
import { RATE_LIMITED_CODE, rateLimitedBody } from "../httpError";

describe("rateLimitedBody", () => {
  it("carries the machine code and the lane-specific detail", () => {
    expect(rateLimitedBody("Too many chat requests. Please try again later."))
      .toEqual({
        code: RATE_LIMITED_CODE,
        detail: "Too many chat requests. Please try again later.",
      });
    expect(RATE_LIMITED_CODE).toBe("rate_limited");
  });
});

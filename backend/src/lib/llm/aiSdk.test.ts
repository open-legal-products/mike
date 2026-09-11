import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ITERATIONS, stopNotice } from "./aiSdk";

describe("stopNotice", () => {
  it("says nothing when the model finished on its own", () => {
    expect(stopNotice(3, DEFAULT_MAX_ITERATIONS, "stop")).toBe("");
  });

  it("says nothing when the round count is a coincidence", () => {
    // Used every round AND finished. Warning here would put a scary footer
    // under a perfectly good answer.
    expect(
      stopNotice(DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS, "stop"),
    ).toBe("");
  });

  it("names the step limit when the model was cut off mid-work", () => {
    // Still asking for tools on the final round: stopWhen ended the run, and
    // without this the turn renders as a bare "Completed in N steps".
    const notice = stopNotice(
      DEFAULT_MAX_ITERATIONS,
      DEFAULT_MAX_ITERATIONS,
      "tool-calls",
    );
    expect(notice).toMatch(/step limit, not a length limit/);
    expect(notice).toContain(String(DEFAULT_MAX_ITERATIONS));
  });

  it("distinguishes a real output-limit truncation from the step limit", () => {
    const notice = stopNotice(2, DEFAULT_MAX_ITERATIONS, "length");
    expect(notice).toMatch(/output limit/);
    expect(notice).not.toMatch(/step limit/);
  });

  it("stays quiet below the cap", () => {
    expect(stopNotice(1, DEFAULT_MAX_ITERATIONS, "tool-calls")).toBe("");
    expect(stopNotice(0, DEFAULT_MAX_ITERATIONS, undefined)).toBe("");
  });
});

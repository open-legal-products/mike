import { describe, expect, it } from "vitest";
import { eventBudget, repeatEventLimit } from "./sentryVolume";

describe("reporting volume policy", () => {
  it("separates a new severity from exhausted repeats and resets repeats daily", () => {
    let now = 0;
    const accepts = eventBudget({ repeatEventsPerDay: 1, now: () => now });
    const event = (level = "warning") => ({ level, fingerprint: ["one"], tags: {} });
    expect(accepts(event())).toBe(true);
    expect(accepts(event())).toBe(true);
    expect(accepts(event())).toBe(false);
    expect(accepts(event())).toBe(false);
    expect(accepts(event("fatal"))).toBe(true);
    expect(accepts({ fingerprint: ["new"], tags: {} })).toBe(true);
    // A day later the repeat allowance and quiet issue count are reset.
    for (let hour = 1; hour < 24; hour++) {
      now = hour * 60 * 60_000 - 1;
      accepts({ fingerprint: ["clock"], tags: {} });
    }
    now = 24 * 60 * 60_000;
    expect(accepts(event())).toBe(true);
    expect(accepts(event())).toBe(true);
  });

  it("counts eligible observations before sampling and always permits diagnostic probes", () => {
    const accepts = eventBudget({ repeatEventsPerDay: 0 });
    const first = { fingerprint: ["one"], tags: {} };
    const repeat = { fingerprint: ["one"], tags: {} };
    expect(accepts(first)).toBe(true);
    expect(accepts(repeat)).toBe(false);
    expect(repeat.tags).toEqual({ occurrence: 2 });
    expect(accepts({ fingerprint: ["one"], tags: { diagnostic_test: "true" } })).toBe(true);
  });

  it.each([undefined, "", "-1", "bad", "1.5", "Infinity"])("uses destination defaults for invalid configuration %s", raw => {
    expect(repeatEventLimit(raw, true)).toBe(50);
    expect(repeatEventLimit(raw, false)).toBe(Infinity);
  });
  it("accepts an explicit nonnegative repeat limit", () => {
    expect(repeatEventLimit("0", false)).toBe(0);
    expect(repeatEventLimit(" 200 ", true)).toBe(200);
  });
});

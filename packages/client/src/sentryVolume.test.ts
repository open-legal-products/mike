import { describe, expect, it } from "vitest";
import { eventBudget, eventBudgetLimits, repeatEventLimit } from "./sentryVolume";

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

  it("counts observations and permits probes within the hard ceiling", () => {
    const accepts = eventBudget({ repeatEventsPerDay: 0 });
    const first = { fingerprint: ["one"], tags: {} };
    const repeat = { fingerprint: ["one"], tags: {} };
    expect(accepts(first)).toBe(true);
    expect(accepts(repeat)).toBe(false);
    expect(repeat.tags).toEqual({ occurrence: 2 });
    expect(accepts({ fingerprint: ["one"], tags: { diagnostic_test: "true" } })).toBe(true);
  });

  it.each([undefined, "", "-1", "bad", "1.5", "Infinity"])("uses destination defaults for invalid configuration %s", raw => {
    expect(repeatEventLimit(raw, true)).toBe(25);
    expect(repeatEventLimit(raw, false)).toBe(Infinity);
  });
  it("accepts an explicit nonnegative repeat limit", () => {
    expect(repeatEventLimit("0", false)).toBe(0);
    expect(repeatEventLimit(" 200 ", true)).toBe(25);
  });
});

const issue = (id: number) => ({ fingerprint: [`issue-${id}`] });
it("caps ten issues recurring every 61 minutes at 50 total, then renews next day", () => {
  let now = 0;
  const accepts = eventBudget({ now: () => now });
  let sent = 0;
  for (let hour = 0; hour < 24; hour++) {
    now = hour * 61 * 60_000;
    for (let id = 0; id < 10; id++) if (accepts(issue(id))) sent++;
  }
  expect(sent).toBe(50);
  now = 24 * 60 * 60_000;
  expect(accepts(issue(0))).toBe(true);
});
it("does not replenish the daily ceiling when 1,001 issue keys evict old entries", () => {
  const accepts = eventBudget();
  let sent = 0;
  for (let id = 0; id < 1001; id++) if (accepts(issue(id))) sent++;
  for (let id = 0; id < 1001; id++) if (accepts(issue(id))) sent++;
  expect(sent).toBe(50);
});
it("counts diagnostic probes toward the same hard ceiling", () => {
  const accepts = eventBudget();
  let sent = 0;
  for (let n = 0; n < 60; n++) if (accepts({ tags: { diagnostic_test: "true" } })) sent++;
  expect(sent).toBe(50);
});
it("recognizes the resolved shared project regardless of key or explicit configuration", () => {
  const community = ["https://original@sentry.example/42"];
  for (const dsn of [community[0], "https://rotated@sentry.example/42/"]) {
    expect(eventBudgetLimits(undefined, dsn!, community)).toEqual({ eventsPerDay: 50, repeatEventsPerDay: 25 });
    expect(eventBudgetLimits("999", dsn!, community)).toEqual({ eventsPerDay: 50, repeatEventsPerDay: 25 });
  }
  expect(eventBudgetLimits(undefined, "https://original@sentry.example/43", community)).toEqual({ eventsPerDay: Infinity, repeatEventsPerDay: Infinity });
});

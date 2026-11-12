import { afterEach, describe, expect, it, vi } from "vitest";
import { eventBudget, eventBudgetLimits, repeatEventLimit } from "./sentryVolume";

afterEach(() => vi.restoreAllMocks());

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
it("keeps quiet recurrences inside the repeat allowance, then renews next day", () => {
  let now = 0;
  const accepts = eventBudget({ now: () => now });
  let sent = 0;
  for (let hour = 0; hour < 24; hour++) {
    now = hour * 61 * 60_000;
    for (let id = 0; id < 10; id++) if (accepts(issue(id))) sent++;
  }
  expect(sent).toBe(35); // Ten first observations plus at most 25 repeats.
  expect(accepts(issue(100))).toBe(true);
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

const atSite = (fingerprint: string[], site: number, level = "warning") => ({
  fingerprint, level,
  exception: { values: [{ type: site % 2 ? "TypeError" : "Error", stacktrace: { frames: [{ filename: `backend/src/site${site}.ts`, lineno: site + 1 }] } }] },
});
it.each(["upstream-unavailable", "api-unreachable", "runtime-warning"])("treats %s from different stack sites as repeats, leaving room for unrelated failures", pinned => {
  const accepts = eventBudget({ repeatEventsPerDay: 0 });
  const fingerprint = [pinned, "component", "cause"];
  expect(accepts(atSite(fingerprint, 0))).toBe(true);
  for (let site = 1; site < 60; site++) expect(accepts(atSite(fingerprint, site))).toBe(false);
  expect(accepts(atSite(["{{ default }}", "unrelated"], 100, "error"))).toBe(true);
  // Severity escalation and different pinned causes still get a first event.
  expect(accepts(atSite(fingerprint, 101, "error"))).toBe(true);
  expect(accepts(atSite([pinned, "component", "different-cause"], 102))).toBe(true);
});
it("retains stack grouping when the fingerprint includes the default placeholder", () => {
  const accepts = eventBudget({ repeatEventsPerDay: 0 });
  const fingerprint = ["{{ default }}", "component"];
  expect(accepts(atSite(fingerprint, 0))).toBe(true);
  expect(accepts(atSite(fingerprint, 2))).toBe(true);
  expect(accepts(atSite(fingerprint, 2))).toBe(false);
});

it("reserves capacity for new failures and severity escalations after quiet repeats", () => {
  let now = 0;
  const accepts = eventBudget({ now: () => now });
  let sent = 0;
  for (let hour = 0; hour < 24; hour++) {
    now = hour * 61 * 60_000;
    for (let id = 0; id < 2; id++) {
      if (accepts({ fingerprint: [`outage-${id}`], level: "warning" })) sent++;
    }
  }
  expect(sent).toBe(27);
  expect(accepts({ fingerprint: ["outage-0"], level: "error" })).toBe(true);
  expect(accepts({ fingerprint: ["new-defect"], level: "error" })).toBe(true);
});

it("does not treat an accepted issue as new after its occurrence entry is evicted", () => {
  const accepts = eventBudget({ eventsPerDay: Infinity, repeatEventsPerDay: 0 });
  for (let id = 0; id < 1000; id++) expect(accepts(issue(id))).toBe(true);
  // Bound daily identity memory, conservatively sampling unknown overflow.
  expect(accepts(issue(1000))).toBe(false);
  // Its occurrence entry was evicted, but its daily identity was not.
  expect(accepts(issue(0))).toBe(false);
});

it("logs the hard-ceiling rejection once per reporting day without event details", () => {
  let now = 0;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const accepts = eventBudget({ eventsPerDay: 1, now: () => now });
  expect(accepts(issue(0))).toBe(true);
  expect(warn).not.toHaveBeenCalled();
  for (let n = 0; n < 5; n++) {
    expect(accepts({ fingerprint: ["PRIVATE_DIAGNOSTIC_CANARY"], tags: { secret: "PRIVATE_DIAGNOSTIC_CANARY" } })).toBe(false);
  }
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_DIAGNOSTIC_CANARY");
  now = 24 * 60 * 60_000;
  expect(accepts(issue(0))).toBe(true);
  expect(accepts(issue(1))).toBe(false);
  expect(warn).toHaveBeenCalledTimes(2);
});

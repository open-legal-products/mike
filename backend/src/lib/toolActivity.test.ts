/**
 * Tool activity counts: what is added up, when it is logged, what a tool is
 * counted under, and the line an operator reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLogForwarder } from "./log";
import {
  CONNECTOR_TOOL_LABEL,
  countToolActivity,
  flushToolActivity,
  setToolActivitySinkForTests,
  TOOL_ACTIVITY_FLUSH_INTERVAL_MS,
  TOOL_ACTIVITY_LOG_PREFIX,
  toolActivityEnabled,
  toolActivityLabel,
  type ToolActivityCount,
} from "./toolActivity";

function collect() {
  const writes: ToolActivityCount[][] = [];
  setToolActivitySinkForTests((counts) => {
    writes.push(counts.map((count) => ({ ...count })));
  });
  return writes;
}

afterEach(() => {
  setToolActivitySinkForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tool activity counts", () => {
  it("adds up the same kind, tool and outcome into one entry per write", () => {
    const writes = collect();
    countToolActivity("tool_input", "read_document", "refused");
    countToolActivity("tool_input", "read_document", "refused");
    countToolActivity("tool_input", "read_document", "passed", true);
    countToolActivity("script_run", "run_script", "timeout");
    flushToolActivity();
    expect(writes).toEqual([
      [
        { kind: "tool_input", tool: "read_document", outcome: "refused", count: 2 },
        { kind: "tool_input", tool: "read_document", outcome: "passed", count: 1 },
        { kind: "script_run", tool: "run_script", outcome: "timeout", count: 1 },
      ],
    ]);
    flushToolActivity();
    expect(writes).toHaveLength(1);
  });

  it("writes a refusal on the next tick and a passed check on the timer", async () => {
    vi.useFakeTimers();
    const writes = collect();
    countToolActivity("tool_input", "read_document", "passed", true);
    await vi.advanceTimersByTimeAsync(TOOL_ACTIVITY_FLUSH_INTERVAL_MS - 1);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);

    countToolActivity("tool_input", "read_document", "refused");
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual([
      { kind: "tool_input", tool: "read_document", outcome: "refused", count: 1 },
    ]);
  });

  it("counts every connector tool under one label and never a made-up name", () => {
    expect(toolActivityLabel("read_document")).toBe("read_document");
    expect(toolActivityLabel("mcp_acme-matters_search_ab12")).toBe(CONNECTOR_TOOL_LABEL);
    expect(toolActivityLabel("Smith v Jones settlement")).toBe("other");
    expect(toolActivityLabel("x".repeat(65))).toBe("other");
  });

  it("logs one parseable line per write, and survives a log stream that throws", () => {
    vi.stubEnv("TOOL_ACTIVITY_COUNTS", "on");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    countToolActivity("script_run", "run_script", "timeout");
    countToolActivity("tool_input", "mcp_acme-matters_search_ab12", "refused");
    flushToolActivity();
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line.startsWith(`${TOOL_ACTIVITY_LOG_PREFIX} `)).toBe(true);
    expect(JSON.parse(line.slice(TOOL_ACTIVITY_LOG_PREFIX.length))).toEqual({
      counts: [
        { kind: "script_run", tool: "run_script", outcome: "timeout", count: 1 },
        { kind: "tool_input", tool: "connector", outcome: "refused", count: 1 },
      ],
    });
    expect(line).not.toContain("acme");

    log.mockImplementation(() => {
      throw new Error("EPIPE");
    });
    countToolActivity("script_run", "run_script", "ok");
    expect(() => flushToolActivity()).not.toThrow();
    vi.unstubAllEnvs();
  });

  it("sends each count to the forwarder as a counter and a log", () => {
    vi.stubEnv("TOOL_ACTIVITY_COUNTS", "on");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logs: unknown[][] = [];
    const metrics: unknown[][] = [];
    setLogForwarder({
      log: (...args) => void logs.push(args),
      metric: (...args) => void metrics.push(args),
    });
    countToolActivity("tool_input", "read_document", "refused");
    countToolActivity("tool_input", "read_document", "refused");
    flushToolActivity();
    const attributes = { kind: "tool_input", tool: "read_document", outcome: "refused" };
    expect(metrics).toEqual([["tool_activity", 2, attributes]]);
    expect(logs).toEqual([["info", "[tool-activity] counted", { ...attributes, count: 2 }]]);
    setLogForwarder(null);
    vi.unstubAllEnvs();
  });

  it("counts nothing when turned off", () => {
    expect(toolActivityEnabled({ TOOL_ACTIVITY_COUNTS: "off" })).toBe(false);
    expect(toolActivityEnabled({ TOOL_ACTIVITY_COUNTS: " OFF " })).toBe(false);
    expect(toolActivityEnabled({})).toBe(true);
    // The suite runs with TOOL_ACTIVITY_COUNTS=off and no sink: a count
    // schedules nothing and logs nothing.
    const timers = vi.spyOn(globalThis, "setImmediate");
    countToolActivity("script_run", "run_script", "ok");
    expect(timers).not.toHaveBeenCalled();
  });
});

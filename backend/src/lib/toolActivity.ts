import { countMetric, forwardLogEvent } from "./log";

/**
 * Counts of what tool-call validation and run_script did, written to the
 * process log so an operator can answer "how many calls were refused, per
 * tool" and "how did scripts end" from whatever keeps the logs (see
 * docs/tool-call-validation.md and docs/run-script.md).
 *
 * Counts are added up in memory and logged together as one line:
 *
 *   [tool-activity] {"counts":[{"kind":"tool_input","tool":"read_document","outcome":"refused","count":2}]}
 *
 * A count is a kind, a tool, an outcome and a number. Nothing about a user,
 * a conversation, the arguments or a document is logged.
 *
 * Routine counts (a call that passed its check) are logged every
 * FLUSH_INTERVAL_MS; anything else (a refusal, a script's end) on the next
 * tick, so a short-lived process still logs them. Counting never throws and
 * never delays the call it describes.
 *
 * With SENTRY_LOGS=on each count also goes to Sentry, as a
 * `tool_activity` counter and as a `[tool-activity] counted` log, both with
 * kind, tool and outcome attributes (docs/observability.md, "Structured
 * logs and metrics").
 *
 * Off with TOOL_ACTIVITY_COUNTS=off.
 */
export type ToolActivityKind =
  /** The check of a call the model made. */
  | "tool_input"
  /** The check of a call a script made. */
  | "script_tool_input"
  /** How one run_script call ended. */
  | "script_run"
  /** One tool call a script made that reached the dispatcher. */
  | "script_tool_call"
  /** A per-script limit a script met; counted once per script. */
  | "script_limit";

export type ToolActivityCount = {
  kind: ToolActivityKind;
  tool: string;
  outcome: string;
  count: number;
};

export type ToolActivitySink = (counts: ToolActivityCount[]) => void;

export const TOOL_ACTIVITY_LOG_PREFIX = "[tool-activity]";

export const TOOL_ACTIVITY_FLUSH_INTERVAL_MS = 30_000;
/** Distinct (kind, tool, outcome) held between two log lines. */
const MAX_BUFFERED_KEYS = 2_000;
/** For every connector tool: its name carries the connector's own name and id. */
export const CONNECTOR_TOOL_LABEL = "connector";

export function toolActivityEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.TOOL_ACTIVITY_COUNTS?.trim().toLowerCase() !== "off";
}

/**
 * The name a tool is counted under. Mike's own tools have names written in
 * its source. A connector tool's name is built from what a user called the
 * connector and what its server called the tool, so all of them share one
 * label.
 */
export function toolActivityLabel(toolName: string): string {
  if (toolName.startsWith("mcp_")) return CONNECTOR_TOOL_LABEL;
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(toolName) ? toolName : "other";
}

const logCounts: ToolActivitySink = (counts) => {
  console.log(`${TOOL_ACTIVITY_LOG_PREFIX} ${JSON.stringify({ counts })}`);
  for (const { kind, tool, outcome, count } of counts) {
    countMetric("tool_activity", count, { kind, tool, outcome });
    forwardLogEvent("info", "tool-activity", "counted", { kind, tool, outcome, count });
  }
};

let sink: ToolActivitySink | null = null;
let buffered = new Map<string, ToolActivityCount>();
let timer: ReturnType<typeof setTimeout> | null = null;
let soon: ReturnType<typeof setImmediate> | null = null;

/** Test seam: where counts go, and counting on whatever the environment says. */
export function setToolActivitySinkForTests(next: ToolActivitySink | null) {
  sink = next;
  buffered = new Map();
  if (timer) clearTimeout(timer);
  timer = null;
  if (soon) clearImmediate(soon);
  soon = null;
}

function add(into: Map<string, ToolActivityCount>, item: ToolActivityCount) {
  const key = `${item.kind}\n${item.tool}\n${item.outcome}`;
  const existing = into.get(key);
  if (existing) existing.count += item.count;
  else if (into.size < MAX_BUFFERED_KEYS) into.set(key, { ...item });
}

/**
 * Count one event. `routine` events wait for the next timed write; the rest
 * are logged on the next tick.
 */
export function countToolActivity(
  kind: ToolActivityKind,
  toolName: string,
  outcome: string,
  routine = false,
): void {
  if (!sink && !toolActivityEnabled()) return;
  add(buffered, { kind, tool: toolActivityLabel(toolName), outcome, count: 1 });
  if (routine) {
    if (timer || soon) return;
    timer = setTimeout(() => {
      timer = null;
      flushToolActivity();
    }, TOOL_ACTIVITY_FLUSH_INTERVAL_MS);
    // A pending count must not hold a finished process open.
    timer.unref?.();
    return;
  }
  if (soon) return;
  soon = setImmediate(() => {
    soon = null;
    flushToolActivity();
  });
}

/** Log what has been counted since the last line. Never throws. */
export function flushToolActivity(): void {
  if (!buffered.size) return;
  const pending = buffered;
  buffered = new Map();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    (sink ?? logCounts)([...pending.values()]);
  } catch {
    // A log stream that is gone must not fail the call being counted.
  }
}

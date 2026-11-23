import { countMetric } from "../../../lib/log";

/** Answer-level denominator plus distinct reference counts. No text goes to telemetry. */
export function countCitationOutcome(
  kind: "completed" | "stopped" | "failed" | "paused",
  text: string,
  delivered: unknown[],
  unavailable: number,
) {
  // Same numeric and grouped marker grammar as the web citation renderer.
  const markers = new Set<number>();
  for (const match of text.matchAll(/\[(\d+(?:,\s*\d+)*)\]/g)) {
    for (const ref of match[1].split(",")) markers.add(Number(ref));
  }
  const rows = delivered as Array<{ ref: number; verified?: boolean }>;
  const refs = new Set(rows.map(row => row.ref));
  const missing = [...markers].filter(ref => !refs.has(ref)).length;
  const outcome = missing || unavailable ? "unresolved" : markers.size ? "resolved" : "no_markers";
  countMetric("citation_turns", 1, { kind, outcome });

  const counts = {
    missing_ref: missing,
    unavailable_passage: unavailable,
    unused_ref: rows.filter(row => !markers.has(row.ref)).length,
    unverified_ref: rows.filter(row => row.verified === false).length,
  };
  for (const [reason, count] of Object.entries(counts)) {
    if (count) countMetric("citation_issues", count, { kind, outcome: reason });
  }
}

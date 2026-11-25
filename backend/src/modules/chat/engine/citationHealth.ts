import type { AssistantEvent } from "@mike/contracts";
import { countMetric, logEvent, type LogAttributes } from "../../../lib/log";
import type { CitationFormat } from "./inlineCitations";

/**
 * How well one answer's citations hold together, from counts only: no text,
 * quote, filename or identifier is recorded.
 *
 * How often does a reader see [N] markers that point at nothing, or quotes
 * the server could not find? It is reported for every answer in both
 * formats (cite_sources and inline), so they can be compared on real
 * traffic.
 */
export type CitationHealth = {
  format: CitationFormat;
  outcome: "completed" | "stopped" | "failed";
  surface: "chat" | "subagent" | "custom";
  /** Distinct [N] markers in the visible answer. */
  markers: number;
  citations: number;
  /** Markers with no citation behind them. */
  danglingMarkers: number;
  /** Citations no marker uses. */
  unusedCitations: number;
  /** The reported failure: markers shown and no citation at all. */
  markersWithoutCitations: boolean;
  /** Refs that are not 1..N. */
  refGaps: boolean;
  quotes: number;
  unverifiedQuotes: number;
  /** Inline only: tags that could not be read and were dropped. */
  inlineMalformed: number;
  /** Inline only: tags naming a passage or cell that does not exist. */
  inlineUnresolved: number;
  /** Inline only: quoted tags shown as text because the sentence needed them. */
  inlineQuoteAsText: number;
};

const MARKER = /\[(\d{1,3})\]/g;

/** The visible answer of a turn: its content events, in order. */
export function visibleTextOf(events: readonly AssistantEvent[]): string {
  return events
    .map((e) => (e.type === "content" ? e.text : ""))
    .join("");
}

type QuoteLike = { verification?: { verified?: unknown } };
type CitationLike = { ref?: unknown; verified?: unknown; quotes?: QuoteLike[] };

export function assessCitationHealth(input: {
  format: CitationFormat;
  outcome: CitationHealth["outcome"];
  surface: CitationHealth["surface"];
  visibleText: string;
  citations: readonly unknown[];
  inlineMalformed?: number;
  inlineUnresolved?: number;
  inlineQuoteAsText?: number;
}): CitationHealth {
  const markers = new Set(
    [...input.visibleText.matchAll(MARKER)].map((m) => Number(m[1])),
  );
  const refs = new Set<number>();
  let quotes = 0;
  let unverifiedQuotes = 0;
  for (const raw of input.citations as CitationLike[]) {
    if (typeof raw?.ref === "number") refs.add(raw.ref);
    const rows = Array.isArray(raw?.quotes) ? raw.quotes : [];
    if (rows.length === 0) {
      quotes += 1;
      if (raw?.verified === false) unverifiedQuotes += 1;
    }
    for (const row of rows) {
      quotes += 1;
      if ((row?.verification?.verified ?? raw?.verified) === false) {
        unverifiedQuotes += 1;
      }
    }
  }
  const danglingMarkers = [...markers].filter((m) => !refs.has(m)).length;
  const unusedCitations = [...refs].filter((r) => !markers.has(r)).length;
  const sorted = [...refs].sort((a, b) => a - b);
  return {
    format: input.format,
    outcome: input.outcome,
    surface: input.surface,
    markers: markers.size,
    citations: input.citations.length,
    danglingMarkers,
    unusedCitations,
    markersWithoutCitations: markers.size > 0 && input.citations.length === 0,
    refGaps: sorted.some((r, i) => r !== i + 1),
    quotes,
    unverifiedQuotes,
    inlineMalformed: input.inlineMalformed ?? 0,
    inlineUnresolved: input.inlineUnresolved ?? 0,
    inlineQuoteAsText: input.inlineQuoteAsText ?? 0,
  };
}

/**
 * Records one answer's citation health: a counter for every answer, and a
 * log line when something is wrong. Values are counts and fixed labels.
 */
export function reportCitationHealth(
  input: Parameters<typeof assessCitationHealth>[0],
): CitationHealth {
  const health = assessCitationHealth(input);
  const broken =
    health.danglingMarkers > 0 ||
    health.unverifiedQuotes > 0 ||
    health.inlineMalformed > 0 ||
    health.inlineUnresolved > 0 ||
    health.inlineQuoteAsText > 0;
  // Only kind, tool, outcome and count leave the process (see
  // TELEMETRY_ATTRIBUTES), so the format and whether the answer is broken
  // are in the metric's name, which is a fixed string per case.
  const labels: LogAttributes = { kind: health.surface, outcome: health.outcome };
  const inline = health.format === "inline";
  if (inline && broken) countMetric("chat_citation_answers.inline.broken", 1, labels);
  else if (inline) countMetric("chat_citation_answers.inline.ok", 1, labels);
  else if (broken) countMetric("chat_citation_answers.cite_sources.broken", 1, labels);
  else countMetric("chat_citation_answers.cite_sources.ok", 1, labels);
  if (health.danglingMarkers > 0) {
    if (inline) countMetric("chat_citation_dangling_markers.inline", health.danglingMarkers, labels);
    else countMetric("chat_citation_dangling_markers.cite_sources", health.danglingMarkers, labels);
  }
  if (broken) {
    // The forwarded line carries the surface and outcome; the counts are
    // printed here and stay in this process.
    const detail = {
      markers: health.markers,
      citations: health.citations,
      dangling_markers: health.danglingMarkers,
      unused_citations: health.unusedCitations,
      markers_without_citations: health.markersWithoutCitations,
      ref_gaps: health.refGaps,
      quotes: health.quotes,
      unverified_quotes: health.unverifiedQuotes,
      inline_malformed: health.inlineMalformed,
      inline_unresolved: health.inlineUnresolved,
      inline_quote_as_text: health.inlineQuoteAsText,
    };
    const attributes = { ...labels, count: health.danglingMarkers };
    if (inline) logEvent("info", "chat/citations", "inline citation health", attributes, detail);
    else logEvent("info", "chat/citations", "cite_sources citation health", attributes, detail);
  }
  return health;
}

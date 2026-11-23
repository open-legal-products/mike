import {
  createCitation,
  MAX_PARSED_CITATIONS,
  normalizeCitation,
  type ParsedCitation,
} from "./citations";
import {
  resolveDoc,
  resolveDocLabel,
  type DocIndex,
  type DocStore,
} from "./types";
import { verifyCitations, type CaseOpinionSource } from "./verifyCitations";

/**
 * The assistant records what its answer cites with this tool before it
 * writes the answer, instead of appending a <CITATIONS> block after it. A
 * block at the very end is the part of an answer a model most often forgets
 * or cuts short; a tool call is structured, checked when it is made, and
 * answered, so a quote that is not in its source can be corrected before the
 * prose that relies on it is written.
 */
export const CITE_SOURCES_TOOL_NAME = "cite_sources";

const MAX_QUOTES_PER_CITATION = 3;
/** How much of a quote the tool result repeats back when it flags it. */
const MAX_ECHOED_QUOTE_CHARS = 160;

export const CITE_SOURCES_TOOL = {
  type: "function",
  function: {
    name: CITE_SOURCES_TOOL_NAME,
    description:
      "Record the passages your answer will cite. Call it after your research and BEFORE you write the answer, with one entry per [N] marker the answer will contain, then write the answer placing those markers. Each quote is checked against its source and the result lists any that were not found, so you can correct them first. Calling it again adds entries; an entry whose ref was already recorded replaces it. Do not call it when the answer cites nothing.",
    parameters: {
      type: "object",
      properties: {
        citations: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PARSED_CITATIONS,
          description:
            "One entry per citation marker, in the order the markers first appear in the answer.",
          items: {
            type: "object",
            properties: {
              ref: {
                type: "integer",
                minimum: 1,
                description:
                  "The marker number: the entry with ref 2 backs every [2] in the answer. Refs run 1 through N with no gaps.",
              },
              doc_id: {
                type: "string",
                description:
                  'For a document: its exact chat-local label, such as "doc-0". Never a filename or document UUID.',
              },
              cluster_id: {
                type: "integer",
                description:
                  "For a CourtListener case: its cluster id. Leave out doc_id and page.",
              },
              quotes: {
                type: "array",
                minItems: 1,
                maxItems: MAX_QUOTES_PER_CITATION,
                description:
                  "The passages that support the claim: one by default, at most three.",
                items: {
                  type: "object",
                  properties: {
                    quote: {
                      type: "string",
                      description:
                        "Exact verbatim text from the source, ideally 25 words or fewer. For a spreadsheet, the plain cell value.",
                    },
                    page: {
                      type: "string",
                      description:
                        'The sequential [Page N] marker number, such as "3", or "41-42" for one quote crossing a page break (mark the break with [[PAGE_BREAK]]). Omit for unpaginated files, spreadsheets and cases.',
                    },
                    sheet: {
                      type: "string",
                      description: "Spreadsheets only: the sheet name.",
                    },
                    cell: {
                      type: "string",
                      description:
                        'Spreadsheets only: the A1 address or range quoted, such as "B7" or "B7:C9"; for a merged cell, the full range from its tag.',
                    },
                    opinion_id: {
                      type: "integer",
                      description: "Cases only: the opinion the quote is from.",
                    },
                  },
                  required: ["quote"],
                },
              },
            },
            required: ["ref", "quotes"],
          },
        },
      },
      required: ["citations"],
    },
  },
};

/** `read`, memoized by document for one verification pass. */
export function onceEach(
  read: (docId: string) => Promise<string>,
): (docId: string) => Promise<string> {
  const byDocId = new Map<string, Promise<string>>();
  return (docId) => {
    let pending = byDocId.get(docId);
    if (!pending) {
      pending = read(docId);
      byDocId.set(docId, pending);
    }
    return pending;
  };
}

export type CitationRecorderDeps = {
  docIndex: DocIndex;
  docStore: DocStore;
  casesByClusterId: Parameters<typeof createCitation>[2];
  /** Reads a document's text; each record call reads a document once. */
  readSourceText: (docId: string) => Promise<string>;
  getCaseOpinions: (clusterId: number) => Promise<CaseOpinionSource[]>;
};

type RecordedCitation = Record<string, unknown> & { ref: number };

type QuoteRow = {
  quote?: unknown;
  verification?: { verified?: unknown };
};

const echo = (quote: string) =>
  quote.length > MAX_ECHOED_QUOTE_CHARS
    ? `${quote.slice(0, MAX_ECHOED_QUOTE_CHARS)}…`
    : quote;

function entryRef(raw: unknown): number | null {
  const ref = (raw as { ref?: unknown } | null)?.ref;
  return typeof ref === "number" && Number.isInteger(ref) ? ref : null;
}

/** Why an entry the normalizer accepted still cannot be cited. */
function unknownSource(
  citation: ParsedCitation,
  deps: CitationRecorderDeps,
): string | null {
  if (citation.kind === "case") return null;
  const known =
    resolveDocLabel(citation.doc_id, deps.docStore, deps.docIndex) ??
    resolveDoc(citation.doc_id, deps.docIndex);
  return known
    ? null
    : `"${citation.doc_id}" is not a document in this conversation. Use its chat-local label, such as "doc-0".`;
}

/**
 * Collects one answer's citations from its cite_sources calls. Each call is
 * verified as it arrives, and the recorded citations are what the answer's
 * citations event carries.
 */
export function createCitationRecorder(deps: CitationRecorderDeps) {
  const byRef = new Map<number, RecordedCitation>();

  const record = async (input: unknown): Promise<string> => {
    const entries = (input as { citations?: unknown } | null)?.citations;
    if (!Array.isArray(entries) || entries.length === 0) {
      return JSON.stringify({
        error:
          "Pass a non-empty citations array: one entry per [N] marker, each with ref, doc_id or cluster_id, and quotes.",
      });
    }

    const rejected: { ref: number | null; error: string }[] = [];
    const built: RecordedCitation[] = [];
    for (const raw of entries.slice(0, MAX_PARSED_CITATIONS)) {
      const parsed = normalizeCitation(raw);
      if (!parsed) {
        rejected.push({
          ref: entryRef(raw),
          error:
            "Each entry needs an integer ref, a doc_id or a cluster_id, and at least one quote.",
        });
        continue;
      }
      const unknown = unknownSource(parsed, deps);
      if (unknown) {
        rejected.push({ ref: parsed.ref, error: unknown });
        continue;
      }
      if (!byRef.has(parsed.ref) && byRef.size >= MAX_PARSED_CITATIONS) {
        rejected.push({
          ref: parsed.ref,
          error: `An answer can cite at most ${MAX_PARSED_CITATIONS} entries.`,
        });
        continue;
      }
      const citation = createCitation(
        parsed,
        deps.docIndex,
        deps.casesByClusterId,
        deps.docStore,
      );
      if (!citation) {
        rejected.push({
          ref: parsed.ref,
          error:
            "The quotes do not occur verbatim in that source. Copy them exactly from the text you read.",
        });
        continue;
      }
      built.push(citation as RecordedCitation);
    }

    const verified = (await verifyCitations(
      built,
      onceEach(deps.readSourceText),
      deps.getCaseOpinions,
    )) as RecordedCitation[];

    const notFound: { ref: number; quote: string }[] = [];
    for (const citation of verified) {
      byRef.set(citation.ref, citation);
      for (const row of (citation.quotes ?? []) as QuoteRow[]) {
        if (row.verification?.verified === false && typeof row.quote === "string") {
          notFound.push({ ref: citation.ref, quote: echo(row.quote) });
        }
      }
    }

    const refs = [...byRef.keys()].sort((a, b) => a - b);
    const gapless = refs.every((ref, index) => ref === index + 1);
    const notes: string[] = [];
    if (notFound.length) {
      notes.push(
        "Some quotes were not found in their source. Call cite_sources again with the same ref and a quote copied exactly from the source, or drop the claim.",
      );
    }
    if (rejected.length) {
      notes.push("Rejected entries were not recorded; correct and resend them.");
    }
    if (!gapless) {
      notes.push(
        "Recorded refs have gaps. Number markers 1 through N in first-appearance order.",
      );
    }
    notes.push(
      "Then write the answer with an inline [N] marker for each recorded ref, where the claim it supports appears. Do not write a <CITATIONS> block or list the quotes in the answer.",
    );

    return JSON.stringify({
      recorded_refs: refs,
      ...(notFound.length ? { quotes_not_found: notFound } : {}),
      ...(rejected.length ? { rejected } : {}),
      next: notes.join(" "),
    });
  };

  return {
    record,
    /** The recorded citations, in ref order. */
    citations(): RecordedCitation[] {
      return [...byRef.values()].sort((a, b) => a.ref - b.ref);
    },
    refs(): ReadonlySet<number> {
      return new Set(byRef.keys());
    },
  };
}

export type CitationRecorder = ReturnType<typeof createCitationRecorder>;

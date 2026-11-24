import {
  createCitation,
  MAX_CITATIONS,
  normalizeCitation,
  type ParsedCitation,
} from "./citations";
import {
  resolveDoc,
  resolveDocLabel,
  type DocIndex,
  type DocStore,
  type TabularCellStore,
} from "./types";
import type {
  CitationsRecordedEvent,
  SourceDocumentType,
} from "@mike/contracts";
import { sourceDocumentType } from "../../../lib/sourceDocuments";
import {
  createQuoteVerifier,
  verifyCitations,
  type CaseOpinionSource,
} from "./verifyCitations";

/**
 * The assistant records what its answer cites with this tool before it
 * writes the answer. A tool call is structured, checked when it is made, and
 * answered, so a quote that is not in its source can be corrected before the
 * prose that relies on it is written. Every chat surface uses it; what an
 * entry names (a document or case, or a review's table cell) depends on the
 * surface.
 */
export const CITE_SOURCES_TOOL_NAME = "cite_sources";

const MAX_QUOTES_PER_CITATION = 3;
/** How much of a quote the tool result repeats back when it flags it. */
const MAX_ECHOED_QUOTE_CHARS = 160;

const TOOL_DESCRIPTION =
  "Record the passages your answer will cite. Call it after your research and BEFORE you write the answer, with one entry per [N] marker the answer will contain, then write the answer placing those markers. Each quote is checked against its source and the result lists any that were not found, so you can correct them first. Calling it again adds entries; an entry whose ref was already recorded replaces it. Do not call it when the answer cites nothing.";

const REF_PROPERTY = {
  type: "integer",
  minimum: 1,
  description:
    "The marker number: the entry with ref 2 backs every [2] in the answer. Refs run 1 through N with no gaps.",
};

function citeSourcesTool(
  entryProperties: Record<string, unknown>,
  required: string[],
) {
  return {
    type: "function",
    function: {
      name: CITE_SOURCES_TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          citations: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CITATIONS,
            description:
              "One entry per citation marker, in the order the markers first appear in the answer.",
            items: {
              type: "object",
              properties: { ref: REF_PROPERTY, ...entryProperties },
              required: ["ref", ...required],
            },
          },
        },
        required: ["citations"],
      },
    },
  };
}

export const CITE_DOCUMENTS_TOOL = citeSourcesTool(
  {
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
  ["quotes"],
);

export const CITE_TABLE_CELLS_TOOL = citeSourcesTool(
  {
    col_index: {
      type: "integer",
      minimum: 0,
      description: "The cell's 0-based column, the N of COL:N.",
    },
    row_index: {
      type: "integer",
      minimum: 0,
      description: "The cell's 0-based row, the N of ROW:N.",
    },
    quote: {
      type: "string",
      description:
        "Exact verbatim text from the cell's summary, as read_table_cells returned it.",
    },
  },
  ["col_index", "row_index", "quote"],
);

type RecordedCitation = Record<string, unknown> & { ref: number };
type CitedSource = CitationsRecordedEvent["sources"][number];
type NotFound = { ref: number; quote: string };

/**
 * What one kind of citation needs from the recorder: the tool the model is
 * given, how an entry becomes a citation, and how its quotes are checked.
 */
export type CitationKind = {
  tool: ReturnType<typeof citeSourcesTool>;
  /** The entry shape, for the error a call without entries gets. */
  entryShape: string;
  build(
    raw: unknown,
  ): { citation: RecordedCitation } | { ref: number | null; error: string };
  /** The citations with their quotes checked, and the quotes not found. */
  verify(
    built: RecordedCitation[],
  ): Promise<{ citations: RecordedCitation[]; notFound: NotFound[] }>;
  sourceOf(citation: RecordedCitation): CitedSource;
};

const SOURCE_TYPES: ReadonlySet<SourceDocumentType> = new Set([
  "docx",
  "pdf",
  "spreadsheet",
  "case",
  "legislation",
  "legal_research",
]);

const echo = (quote: string) =>
  quote.length > MAX_ECHOED_QUOTE_CHARS
    ? `${quote.slice(0, MAX_ECHOED_QUOTE_CHARS)}…`
    : quote;

function entryRef(raw: unknown): number | null {
  const ref = (raw as { ref?: unknown } | null)?.ref;
  return typeof ref === "number" && Number.isInteger(ref) ? ref : null;
}

const isIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

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

// ---------------------------------------------------------------------------
// Documents and cases
// ---------------------------------------------------------------------------

export type DocumentCitationDeps = {
  docIndex: DocIndex;
  docStore: DocStore;
  casesByClusterId: Parameters<typeof createCitation>[2];
  /** Reads a document's text; each record call reads a document once. */
  readSourceText: (docId: string) => Promise<string>;
  getCaseOpinions: (clusterId: number) => Promise<CaseOpinionSource[]>;
};

/** Why an entry the normalizer accepted still cannot be cited. */
function unknownSource(
  citation: ParsedCitation,
  deps: DocumentCitationDeps,
): string | null {
  if (citation.kind === "case") return null;
  const known =
    resolveDocLabel(citation.doc_id, deps.docStore, deps.docIndex) ??
    resolveDoc(citation.doc_id, deps.docIndex);
  return known
    ? null
    : `"${citation.doc_id}" is not a document in this conversation. Use its chat-local label, such as "doc-0".`;
}

/** Citations of documents (uploaded, generated or provider-backed) and cases. */
export function documentCitations(deps: DocumentCitationDeps): CitationKind {
  return {
    tool: CITE_DOCUMENTS_TOOL,
    entryShape: "ref, doc_id or cluster_id, and quotes",
    build(raw) {
      const parsed = normalizeCitation(raw);
      if (!parsed) {
        return {
          ref: entryRef(raw),
          error:
            "Each entry needs an integer ref, a doc_id or a cluster_id, and at least one quote.",
        };
      }
      const unknown = unknownSource(parsed, deps);
      if (unknown) return { ref: parsed.ref, error: unknown };
      const citation = createCitation(
        parsed,
        deps.docIndex,
        deps.casesByClusterId,
        deps.docStore,
      );
      return citation
        ? { citation: citation as RecordedCitation }
        : {
            ref: parsed.ref,
            error:
              "The quotes do not occur verbatim in that source. Copy them exactly from the text you read.",
          };
    },
    async verify(built) {
      const citations = (await verifyCitations(
        built,
        onceEach(deps.readSourceText),
        deps.getCaseOpinions,
      )) as RecordedCitation[];
      const notFound: NotFound[] = [];
      for (const citation of citations) {
        for (const row of (citation.quotes ?? []) as {
          quote?: unknown;
          verification?: { verified?: unknown };
        }[]) {
          if (row.verification?.verified === false && typeof row.quote === "string") {
            notFound.push({ ref: citation.ref, quote: echo(row.quote) });
          }
        }
      }
      return { citations, notFound };
    },
    sourceOf(citation) {
      const document = citation.document as
        | { type?: unknown; title?: unknown }
        | undefined;
      const isCase = citation.kind === "case";
      const named = isCase ? citation.case_name : citation.filename;
      const name =
        typeof named === "string" && named.trim()
          ? named.trim()
          : typeof document?.title === "string" && document.title.trim()
            ? document.title.trim()
            : isCase
              ? "A case"
              : "A document";
      const type = SOURCE_TYPES.has(document?.type as SourceDocumentType)
        ? (document!.type as SourceDocumentType)
        : isCase
          ? "case"
          : sourceDocumentType(name);
      return { name, type, ref: citation.ref };
    },
  };
}

// ---------------------------------------------------------------------------
// Tabular review cells
// ---------------------------------------------------------------------------

/** Citations of a tabular review's cells, checked against what was read. */
export function tabularCitations(store: TabularCellStore): CitationKind {
  return {
    tool: CITE_TABLE_CELLS_TOOL,
    entryShape: "ref, col_index, row_index, and quote",
    build(raw) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const ref = entryRef(raw);
      const { col_index: col, row_index: row, quote } = entry;
      if (
        ref === null ||
        ref < 1 ||
        !isIndex(col) ||
        !isIndex(row) ||
        typeof quote !== "string" ||
        !quote.trim()
      ) {
        return {
          ref,
          error:
            "Each entry needs an integer ref, a col_index and row_index, and a quote.",
        };
      }
      const column = store.columns[col];
      const document = store.documents[row];
      if (!column || !document) {
        return {
          ref,
          error: `COL:${col} ROW:${row} is not a cell of this review.`,
        };
      }
      const cell = store.cells.get(`${column.index}:${document.id}`);
      if (cell === undefined) {
        return {
          ref,
          error: `Read COL:${col} ROW:${row} with read_table_cells before citing it.`,
        };
      }
      if (!cell?.summary) {
        return { ref, error: `COL:${col} ROW:${row} is empty.` };
      }
      return {
        citation: {
          type: "tabular_citation",
          ref,
          col_index: col,
          row_index: row,
          col_name: column.name,
          doc_name: document.filename,
          quote,
        },
      };
    },
    async verify(built) {
      const notFound: NotFound[] = [];
      const citations = built.map((citation) => {
        const document = store.documents[citation.row_index as number];
        const column = store.columns[citation.col_index as number];
        const summary = store.cells.get(`${column.index}:${document.id}`)?.summary ?? "";
        const result = createQuoteVerifier(summary)(citation.quote as string);
        if (!result.verified) {
          notFound.push({ ref: citation.ref, quote: echo(citation.quote as string) });
        }
        // A drifted quote is shown as the cell's own words.
        const quote =
          result.needs_correction && result.source_excerpt
            ? result.source_excerpt
            : citation.quote;
        return { ...citation, quote, verified: result.verified };
      });
      return { citations, notFound };
    },
    sourceOf(citation) {
      const name = String(citation.doc_name);
      return { name, type: sourceDocumentType(name), ref: citation.ref };
    },
  };
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** Each source once, under its lowest ref (citations come in ref order). */
function uniqueSources(
  citations: RecordedCitation[],
  sourceOf: CitationKind["sourceOf"],
): CitedSource[] {
  const byKey = new Map<string, CitedSource>();
  for (const citation of citations) {
    const source = sourceOf(citation);
    const key = citation.type === "tabular_citation"
      ? JSON.stringify(["row", citation.row_index])
      : citation.kind === "case"
        ? JSON.stringify(["case", citation.cluster_id])
        : JSON.stringify(["document", citation.document_id ?? citation.doc_id, citation.version_id ?? citation.version_number ?? null]);
    if (!byKey.has(key)) byKey.set(key, source);
  }
  return [...byKey.values()];
}

/**
 * Collects one answer's citations from its cite_sources calls. Each call is
 * verified as it arrives, and the recorded citations are what the answer's
 * citations event carries.
 */
export function createCitationRecorder(kind: CitationKind) {
  const byRef = new Map<number, RecordedCitation>();

  /** The tool result for the model, and the timeline event for the call. */
  const record = async (
    input: unknown,
  ): Promise<{ content: string; event: CitationsRecordedEvent }> => {
    const entries = (input as { citations?: unknown } | null)?.citations;
    if (!Array.isArray(entries) || entries.length === 0) {
      return {
        content: JSON.stringify({
          error: `Pass a non-empty citations array: one entry per [N] marker, each with ${kind.entryShape}.`,
        }),
        // Shown as a call that recorded nothing.
        event: {
          type: "citations_recorded",
          refs: [],
          sources: [],
          quotes_not_found: 0,
          rejected: 0,
        },
      };
    }

    const rejected: { ref: number | null; error: string }[] = [];
    const built = new Map<number, RecordedCitation>();
    // The cap counts citations, not entries, so invalid entries cannot
    // crowd out a valid one.
    const refsAfterCall = new Set(byRef.keys());
    for (const raw of entries) {
      const result = kind.build(raw);
      if ("error" in result) {
        rejected.push(result);
        continue;
      }
      const { ref } = result.citation;
      if (!refsAfterCall.has(ref) && refsAfterCall.size >= MAX_CITATIONS) {
        rejected.push({
          ref,
          error: `An answer can cite at most ${MAX_CITATIONS} entries.`,
        });
        continue;
      }
      refsAfterCall.add(ref);
      built.set(ref, result.citation);
    }

    const { citations: verified, notFound } = await kind.verify([...built.values()]);
    for (const citation of verified) byRef.set(citation.ref, citation);

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
      "Then write the answer with an inline [N] marker for each recorded ref, where the claim it supports appears. Do not list the citations or quotes in the answer.",
    );

    const thisCall = [...verified].sort((a, b) => a.ref - b.ref);
    return {
      content: JSON.stringify({
        recorded_refs: refs,
        ...(notFound.length ? { quotes_not_found: notFound } : {}),
        ...(rejected.length ? { rejected } : {}),
        next: notes.join(" "),
      }),
      event: {
        type: "citations_recorded",
        refs: [...new Set(thisCall.map((c) => c.ref))],
        sources: uniqueSources(thisCall, kind.sourceOf),
        quotes_not_found: notFound.length,
        rejected: rejected.length,
      },
    };
  };

  return {
    tool: kind.tool,
    record,
    /** The recorded citations, in ref order. */
    citations(): RecordedCitation[] {
      return [...byRef.values()].sort((a, b) => a.ref - b.ref);
    },
  };
}

export type CitationRecorder = ReturnType<typeof createCitationRecorder>;

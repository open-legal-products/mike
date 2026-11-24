import { type DocIndex, type DocStore, resolveDoc, resolveDocLabel } from "./types";
import {
  isExternalSourceDocumentId,
  sourceProviderFor,
  stampSourceDocument,
} from "../../source-documents/sourceDocuments.service";
import { quoteOccursVerbatim } from "./tools/externalSources";
import {
  normalizeCaseDocument,
  sourceDocumentType,
  type SourceDocument,
  type SourceDocumentQuote,
} from "../../../lib/sourceDocuments";
import type { RawCitation } from "./inlineCitations";

// ---------------------------------------------------------------------------
// Internal citation parse types
// ---------------------------------------------------------------------------

type DocumentQuote = {
  verification?: SourceDocumentQuote["verification"];
  page: number | string;
  quote: string;
  // Spreadsheet sources are located by cell instead of page: `sheet` is the
  // worksheet name and `cell` is an A1 address or range (e.g. "B7" or "B7:C9").
  sheet?: string;
  cell?: string;
};

type ParsedDocumentCitation = {
  kind: "document";
  ref: number;
  doc_id: string;
  page: number | string;
  quote: string;
  sheet?: string;
  cell?: string;
  quotes: DocumentQuote[];
};

type ParsedCaseCitation = {
  kind: "case";
  ref: number;
  cluster_id: number;
  quotes: {
    opinionId: number | null;
    type: string | null;
    author: string | null;
    quote: string;
  }[];
};

export type ParsedCitation = ParsedDocumentCitation | ParsedCaseCitation;

/** One citation entry as the model wrote it, or null when it is unusable. */
/** Only server-resolved inline passages may supply their own source position. */
export function normalizeInlineCitation(raw: RawCitation): ParsedCitation | null {
  const citation = normalizeCitation(raw);
  if (citation?.kind === "document") {
    citation.quotes.forEach((quote, index) => {
      const verification = raw.quotes?.[index]?.verification;
      if (verification) quote.verification = verification;
    });
  }
  return citation;
}

export function normalizeCitation(raw: unknown): ParsedCitation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const markerRef =
    typeof c.marker === "string"
      ? Number(c.marker.match(/^\[(\d+)\]$/)?.[1])
      : NaN;
  const ref =
    typeof c.ref === "number"
      ? c.ref
      : Number.isFinite(markerRef)
        ? markerRef
        : null;
  if (typeof ref !== "number" || !Number.isSafeInteger(ref) || ref < 1) return null;
  const quote = typeof c.quote === "string" ? c.quote : c.text;

  const rawClusterId =
    typeof c.cluster_id === "number"
      ? c.cluster_id
      : typeof c.clusterId === "number"
        ? c.clusterId
        : typeof c.cluster_id === "string"
          ? Number.parseInt(c.cluster_id, 10)
          : typeof c.clusterId === "string"
            ? Number.parseInt(c.clusterId, 10)
            : NaN;
  if (Number.isFinite(rawClusterId) && rawClusterId > 0) {
    const quotes = normalizeCaseCitationQuotes(c);
    if (!quotes.length) {
      if (typeof quote !== "string" || !quote) return null;
      quotes.push({ opinionId: null, type: null, author: null, quote });
    }
    return { kind: "case", ref, cluster_id: Math.floor(rawClusterId), quotes };
  }

  if (typeof c.doc_id !== "string") return null;
  const quotes = normalizeDocumentCitationQuotes(c);
  if (!quotes.length) {
    if (typeof quote !== "string" || !quote) return null;
    quotes.push({
      page: normalizeCitationPage(c.page),
      quote,
      ...normalizeCellLocator(c),
    });
  }
  return {
    kind: "document",
    ref,
    doc_id: c.doc_id,
    page: quotes[0].page,
    quote: quotes[0].quote,
    sheet: quotes[0].sheet,
    cell: quotes[0].cell,
    quotes,
  };
}

/** Pull an optional spreadsheet `{sheet, cell}` locator off a raw object. */
function normalizeCellLocator(
  c: Record<string, unknown>,
): { sheet?: string; cell?: string } {
  const out: { sheet?: string; cell?: string } = {};
  if (typeof c.sheet === "string" && c.sheet.trim()) out.sheet = c.sheet.trim();
  if (typeof c.cell === "string" && c.cell.trim()) out.cell = c.cell.trim();
  return out;
}

function normalizeCitationPage(value: unknown): number | string {
  if (typeof value === "number") {
    return value;
  } else if (typeof value === "string" && /^\d+\s*-\s*\d+$/.test(value)) {
    return value;
  } else {
    const n = parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n)) return 1;
    return n;
  }
}

function normalizeDocumentCitationQuotes(
  c: Record<string, unknown>,
): DocumentQuote[] {
  if (!Array.isArray(c.quotes)) return [];
  return c.quotes
    .slice(0, 3)
    .map((raw): DocumentQuote | null => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const text = typeof row.quote === "string" ? row.quote : row.text;
      if (typeof text !== "string" || !text.trim()) return null;
      // Fall back to the top-level sheet/cell so a citation can set them once.
      return {
        page: normalizeCitationPage(row.page ?? c.page),
        quote: text,
        ...normalizeCellLocator({
          sheet: row.sheet ?? c.sheet,
          cell: row.cell ?? c.cell,
        }),
      };
    })
    .filter((quote): quote is DocumentQuote => !!quote);
}

function normalizeCaseCitationQuotes(c: Record<string, unknown>) {
  if (!Array.isArray(c.quotes)) return [];
  return c.quotes
    .slice(0, 3)
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const text = typeof row.quote === "string" ? row.quote : row.text;
      if (typeof text !== "string" || !text.trim()) return null;
      const opinionId =
        typeof row.opinion_id === "number" && Number.isFinite(row.opinion_id)
          ? Math.floor(row.opinion_id)
          : typeof row.opinionId === "number" && Number.isFinite(row.opinionId)
            ? Math.floor(row.opinionId)
            : null;
      return {
        opinionId,
        type: typeof row.type === "string" ? row.type : null,
        author: typeof row.author === "string" ? row.author : null,
        quote: text,
      };
    })
    .filter(
      (quote): quote is {
        opinionId: number | null;
        type: string | null;
        author: string | null;
        quote: string;
      } => !!quote,
    );
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_CITATIONS = 50;
export const MAX_CITATION_PAYLOAD_BYTES = 5_000_000;

export function limitCitationPayload(citations: unknown[]): unknown[] {
  const limited: unknown[] = [];
  let totalBytes = 2; // JSON array brackets.
  for (const citation of citations) {
    if (citation == null) continue;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(citation);
    } catch {
      continue;
    }
    if (serialized === undefined) continue;
    const bytes = Buffer.byteLength(serialized, "utf8") + (limited.length ? 1 : 0);
    if (totalBytes + bytes > MAX_CITATION_PAYLOAD_BYTES) continue;
    limited.push(citation);
    totalBytes += bytes;
  }
  return limited;
}


type CasesByClusterId = Map<number, {
  caseName: string | null;
  citations: string[];
  url: string | null;
  pdfUrl: string | null;
  dateFiled: string | null;
}>;

/**
 * A citation of a source read from a provider during this request. The
 * source is not an upload: there is no page or version. A provider that
 * verifies quotes exactly accepts a quote only when it occurs verbatim in
 * the canonical text, so a changed legal quotation can never be surfaced as
 * verified; such a citation is returned null when any quote fails. A
 * provider that verifies tolerantly leaves its quotes to the end-of-turn
 * verification, like an upload's; until that runs they are marked unverified,
 * so a turn that ends before verification (a stopped stream) never stores
 * them as verified. A source no provider owns cannot occur in production
 * (every registered source comes from a provider) and is treated as exact,
 * the safe default.
 */
function createExternalSourceCitation(
  citation: ParsedDocumentCitation,
  label: string,
  document: SourceDocument,
  text: string,
) {
  const exact = sourceProviderFor(document.document_id)?.quoteVerification !== "fuzzy";
  if (exact && citation.quotes.some(({ quote }) => !quoteOccursVerbatim(text, quote))) {
    return null;
  }
  const subdocumentId = document.subdocuments?.[0]?.document_id;
  const quotes: SourceDocumentQuote[] = citation.quotes.map((quote) => ({
    quote: quote.quote,
    verification: { verified: exact },
    target: subdocumentId ? { subdocument_id: subdocumentId } : {},
  }));
  return {
    type: "citation_data",
    kind: "document",
    ref: citation.ref,
    document: { ...document, quotes },
    doc_id: label,
    document_id: document.document_id,
    version_id: null,
    version_number: null,
    filename: document.title,
    verified: exact,
    page: citation.page,
    quote: citation.quote,
    quotes: citation.quotes,
  };
}

/**
 * Builds the citation annotation for one parsed citation, or null when the
 * citation names a request-scoped external source of an exact provider whose
 * quotes do not occur verbatim in it, or a provider id that was never read in
 * this request (callers drop those).
 */
export function createCitation(
  citation: ParsedCitation,
  docIndex: DocIndex,
  casesByClusterId?: CasesByClusterId,
  docStore?: DocStore,
) {
  if (citation.kind === "case") {
    const caseRecord = casesByClusterId?.get(citation.cluster_id);
    // Stamped like every registry document, so the client learns the
    // origin from the wire rather than from the document type.
    const document = stampSourceDocument(
      normalizeCaseDocument({
        clusterId: citation.cluster_id,
        caseName: caseRecord?.caseName,
        citations: caseRecord?.citations,
        url: caseRecord?.url,
        pdfUrl: caseRecord?.pdfUrl,
        dateFiled: caseRecord?.dateFiled,
        quotes: citation.quotes,
      }),
    );
    return {
      type: "citation_data",
      kind: "case",
      ref: citation.ref,
      document,
      cluster_id: citation.cluster_id,
      case_name: caseRecord?.caseName ?? null,
      citation: caseRecord?.citations[0] ?? null,
      url: caseRecord?.url ?? null,
      pdfUrl: caseRecord?.pdfUrl ?? null,
      dateFiled: caseRecord?.dateFiled ?? null,
      quotes: citation.quotes,
    };
  }

  // An external source may be cited by its handle, its title or the
  // provider's document id, and must resolve through the request-scoped
  // store rather than fall through to the tolerant uploaded-document path.
  const sourceLabel = docStore
    ? resolveDocLabel(citation.doc_id, docStore, docIndex)
    : null;
  const sourceEntry = sourceLabel ? docStore?.get(sourceLabel) : undefined;
  // A title shared by two sources cannot identify which one owns the quote.
  if (docStore && !docStore.has(citation.doc_id) && citation.doc_id === sourceEntry?.filename) {
    let matches = 0;
    for (const entry of docStore.values()) {
      if (entry.filename === citation.doc_id && ++matches > 1) return null;
    }
  }
  if (sourceLabel && sourceEntry?.external_source) {
    return createExternalSourceCitation(
      citation,
      sourceLabel,
      sourceEntry.external_source,
      sourceEntry.inline_text ?? "",
    );
  }

  const label = sourceLabel ?? citation.doc_id;
  const docInfo = resolveDoc(label, docIndex);
  // A provider's document id cited without that source having been read in
  // this request has no text to verify against: it never becomes a citation.
  if (
    isExternalSourceDocumentId(citation.doc_id) ||
    (docInfo && isExternalSourceDocumentId(docInfo.document_id))
  ) {
    return null;
  }
  const requestScopedDocument = docStore?.get(label);
  const documentId = docInfo?.document_id ?? label;
  const filename =
    docInfo?.filename ?? requestScopedDocument?.filename ?? citation.doc_id;
  const quotes: SourceDocumentQuote[] = citation.quotes.map((quote) => ({
    quote: quote.quote,
    ...(quote.verification ? { verification: quote.verification } : {}),
    target: {
      page: quote.page,
      ...(quote.sheet ? { sheet: quote.sheet } : {}),
      ...(quote.cell ? { cell: quote.cell } : {}),
    },
  }));
  return {
    type: "citation_data",
    kind: "document",
    ref: citation.ref,
    document: {
      document_id: documentId,
      title: filename,
      type: sourceDocumentType(filename),
      metadata: [],
      quotes,
      version_id: docInfo?.version_id ?? null,
      version_number: docInfo?.version_number ?? null,
    },
    doc_id: label,
    document_id: docInfo?.document_id,
    version_id: docInfo?.version_id ?? null,
    version_number: docInfo?.version_number ?? null,
    filename,
    page: citation.page,
    quote: citation.quote,
    sheet: citation.sheet,
    cell: citation.cell,
    quotes: citation.quotes,
  };
}

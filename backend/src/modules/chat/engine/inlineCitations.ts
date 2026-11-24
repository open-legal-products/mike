/**
 * Inline citations: the model cites at the point of each claim with a tag
 * that names a passage it was shown, and the server numbers the tags.
 *
 * With cite_sources, the model writes every citation and its exact quotes in
 * a tool call before the answer, which costs a model round trip and leaves
 * the answer's markers unchecked against what was recorded. Here the model
 * writes a short tag at each claim: every citation travels with its claim,
 * so a cut-off answer loses only the citations it had not written yet.
 *
 * Document text the model reads is divided into passages, each tagged with a
 * number such as `{12}` (see `annotatePassages`). The split is a pure
 * function of the extracted text, so the server recomputes it when it
 * resolves a tag; the model never has to copy a quote to say where a claim
 * comes from. The model writes:
 *
 *   [[doc-0 12]]                 one passage
 *   [[doc-0 12-13]]              adjacent passages
 *   [[doc-0 12, 15]]             several passages of one document
 *   [[doc-0 12; doc-1 4]]        several sources for one claim
 *   [[doc-0 12 "exact words"]]   a passage, highlighting the quoted words
 *   [[doc-0 "exact words"]]      text without passage numbers
 *   [[doc-2 Sheet name!D4]]      a spreadsheet cell or range
 *   [[case-123 "exact words"]]   a CourtListener case (cluster 123)
 *
 * The stream shows `[N]` in place of each tag, numbered by first appearance.
 * Resolved tags use the existing citation payload. PDF passages can also
 * carry the source position the viewer uses to distinguish repeated text.
 */

import type { QuoteVerification } from "./types";

export type CitationFormat = "cite_sources" | "inline";

/**
 * The format every chat surface (chat, project, Word and tabular) asks for:
 * cite_sources by default; inline with CITATION_FORMAT=inline while it is
 * evaluated.
 */
export function chatCitationFormat(): CitationFormat {
  return process.env.CITATION_FORMAT === "inline" ? "inline" : "cite_sources";
}

// ---------------------------------------------------------------------------
// Passages
// ---------------------------------------------------------------------------

export type Passage = {
  /** 1-based, in document order. */
  id: number;
  /** The `[Page N]` page, or null for text without page markers. */
  page: number | null;
  /** Offsets into the extracted text. */
  start: number;
  end: number;
  text: string;
};

const PAGE_LINE = /^\[Page (\d+)\]$/gm;
/**
 * A line that opens a clause, heading or list item. A bare number is not a
 * clause start: a wrapped line often begins with a date or an amount.
 */
const CLAUSE_START =
  /^\s*(?:\d+(?:\.\d+)+\.?\s|\d+[.)]\s|\([a-z0-9]{1,4}\)\s|[a-z]\)\s|[-•*]\s|(?:SCHEDULE|ARTICLE|PART|SECTION|CLAUSE)\b|[A-Z][A-Z ,&'-]{3,}$)/;
/** Longer paragraphs are cut at sentence ends so a tag stays specific. */
const MAX_PASSAGE_CHARS = 600;
const SENTENCE_END = /(?<=[.!?;])["”')\]]?\s+(?=["“(]?[A-Z0-9])/g;

/** Is this extracted text a spreadsheet rendering (cells are its locators)? */
export function isSpreadsheetText(text: string): boolean {
  return /^## Sheet: /m.test(text.slice(0, 2000));
}

/**
 * Splits extracted document text into citable passages: clauses and
 * paragraphs, cut at sentence ends when long. Deterministic, so the ids the
 * model saw can be resolved later from the same text.
 */
export function segmentPassages(text: string): Passage[] {
  const pages: { page: number | null; start: number; end: number }[] = [];
  const marks = [...text.matchAll(PAGE_LINE)];
  if (marks.length === 0) {
    pages.push({ page: null, start: 0, end: text.length });
  } else {
    marks.forEach((m, i) => {
      const start = m.index! + m[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
      pages.push({ page: Number(m[1]), start, end });
    });
  }

  const passages: Passage[] = [];
  const push = (page: number | null, start: number, end: number) => {
    // Trim, keeping offsets into the original text.
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end - start < 2) return;
    passages.push({
      id: passages.length + 1,
      page,
      start,
      end,
      text: text.slice(start, end),
    });
  };

  for (const { page, start, end } of pages) {
    // Paragraph starts: after a blank line, or a line that opens a clause.
    const cuts: number[] = [start];
    let lineStart = start;
    let previousBlank = false;
    while (lineStart < end) {
      const nl = text.indexOf("\n", lineStart);
      const lineEnd = nl < 0 || nl > end ? end : nl;
      const line = text.slice(lineStart, lineEnd);
      const blank = !line.trim();
      if (!blank && (previousBlank || CLAUSE_START.test(line))) {
        if (cuts.at(-1) !== lineStart) cuts.push(lineStart);
      }
      previousBlank = blank;
      lineStart = lineEnd + 1;
    }
    cuts.push(end);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (b - a <= MAX_PASSAGE_CHARS) {
        push(page, a, b);
        continue;
      }
      // A long paragraph: cut at sentence ends into pieces near the limit.
      const body = text.slice(a, b);
      let pieceStart = 0;
      let lastEnd = 0;
      for (const m of body.matchAll(SENTENCE_END)) {
        const at = m.index! + m[0].length;
        if (at - pieceStart > MAX_PASSAGE_CHARS && lastEnd > pieceStart) {
          push(page, a + pieceStart, a + lastEnd);
          pieceStart = lastEnd;
        }
        lastEnd = at;
      }
      push(page, a + pieceStart, b);
    }
  }
  return passages;
}

/** The text the model reads: each passage prefixed with its `{id}` tag. */
export function annotatePassages(text: string): string {
  if (isSpreadsheetText(text)) return text;
  const passages = segmentPassages(text);
  if (passages.length === 0) return text;
  let out = "";
  let at = 0;
  for (const p of passages) {
    out += text.slice(at, p.start) + `{${p.id}}`;
    at = p.start;
  }
  return out + text.slice(at);
}

/** The note that tells the model how to cite a document it just read. */
export function inlineCitationReminder(
  docLabel: string,
  promptFilename: string,
  isSpreadsheet: boolean,
): string {
  const how = isSpreadsheet
    ? `Cite a cell inline as [[${docLabel} Sheet name!B7]] (or a range such as B7:C9), right after the claim.`
    : `Its passages are tagged {N}; the tags are not document text. Cite inline as [[${docLabel} N]] right after the claim, e.g. [[${docLabel} 12]] or [[${docLabel} 12-13]]. The reader sees only a number in place of the tag, so state the claim fully in your sentence first.`;
  return [
    `[Citation requirement for ${docLabel}]:`,
    `Document filename: ${promptFilename}`,
    how,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Citation tags
// ---------------------------------------------------------------------------

/** One source a tag names. */
export type InlineSource =
  | { kind: "passages"; doc: string; ranges: [number, number][]; quote?: string }
  | { kind: "quote"; doc: string; quote: string }
  | { kind: "cell"; doc: string; sheet: string; cell: string }
  | { kind: "case"; clusterId: number; quote: string }
  /** A tabular review cell: COL:col ROW:row, 0-based positions. */
  | { kind: "table"; col: number; row: number; quote?: string };

/**
 * A document's chat-local label: "doc-0", or the Word add-in's active
 * document, which has no stored id.
 */
const DOC = String.raw`(?:doc-\d+|active-word-document)`;
/** A tabular review cell, as the tabular prompt lists them. */
const TABLE = String.raw`COL:\d+\s+ROW:\d+`;
/** How the inside of a citation tag begins. */
const CITATION_START = new RegExp(String.raw`^\s*(?:${DOC}|case-\d+|${TABLE})`);
const TAG_PREFIXES = ["doc-", "case-", "COL:", "active-word-document"];

const DOC_LABEL = new RegExp(String.raw`^(${DOC})\s*(.*)$`, "s");
const TABLE_LABEL = /^COL:(\d+)\s+ROW:(\d+)\s*(.*)$/s;
const CASE_LABEL = /^case-(\d+)\s*(.*)$/s;
const PASSAGE_LIST = /^\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*$/;
const CELL_REF = /^(.+)!\s*([A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?)$/i;

/** Splits on `;` outside quotes. */
/** A quoted worksheet name, which may hold any character but its quote. */
const QUOTED_SHEET = /'[^'\n]*'(?=\s*!)/g;

/** Splits on `;` outside quotes and outside quoted worksheet names. */
function splitSources(inner: string): string[] {
  // Hide quoted sheet names first: 'Q1; Q2'!B7 is one source.
  const sheets: string[] = [];
  const masked = inner.replace(QUOTED_SHEET, (name) => {
    sheets.push(name);
    return `\u0000${sheets.length - 1}\u0000`;
  });
  const parts: string[] = [];
  let quoted = false;
  let current = "";
  for (const ch of masked) {
    if (ch === '"' || ch === "“" || ch === "”") quoted = ch === "“" ? true : ch === "”" ? false : !quoted;
    if (ch === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts
    .map((p) => p.replace(/\u0000(\d+)\u0000/g, (_, i: string) => sheets[Number(i)]).trim())
    .filter(Boolean);
}

/**
 * A source's locator and quote: the quote runs from the first quotation
 * mark to the last, so quotation marks inside it (an opinion quoting a
 * phrase) are kept. Null when a quote is opened but never closed.
 */
function splitQuote(rest: string): { locator: string; quote?: string } | null {
  const open = rest.search(/["“]/);
  if (open < 0) return { locator: rest.trim() };
  const body = rest.slice(open + 1).trimEnd();
  if (!/["”]$/.test(body)) return null;
  const quote = body.slice(0, -1).trim();
  return quote ? { locator: rest.slice(0, open).trim(), quote } : null;
}

/** Parses the inside of a `[[...]]` tag, or returns null if it is not one. */
export function parseCitationTag(inner: string): InlineSource[] | null {
  const sources: InlineSource[] = [];
  for (const part of splitSources(inner)) {
    const tableMatch = part.match(TABLE_LABEL);
    if (tableMatch) {
      const split = splitQuote(tableMatch[3]);
      if (!split || split.locator) return null;
      sources.push({
        kind: "table",
        col: Number(tableMatch[1]),
        row: Number(tableMatch[2]),
        ...(split.quote ? { quote: split.quote } : {}),
      });
      continue;
    }
    const caseMatch = part.match(CASE_LABEL);
    if (caseMatch) {
      // A case is cited by a quote and nothing else: text before the quote
      // means the tag is not one.
      const split = splitQuote(caseMatch[2]);
      if (!split?.quote || split.locator) return null;
      sources.push({ kind: "case", clusterId: Number(caseMatch[1]), quote: split.quote });
      continue;
    }
    const docMatch = part.match(DOC_LABEL);
    if (!docMatch) return null;
    const doc = docMatch[1];
    const rest = docMatch[2].trim();
    // A cell first: its sheet name may be quoted ('Q1; Q2'!B7 or "Rent"!D4).
    const cell = rest.match(CELL_REF);
    if (cell) {
      const sheet = cell[1].trim().replace(/^['"“]|['"”]$/g, "");
      sources.push({ kind: "cell", doc, sheet, cell: cell[2].toUpperCase() });
      continue;
    }
    const split = splitQuote(rest);
    if (!split) return null;
    const { locator, quote } = split;
    if (!locator) {
      if (!quote) return null;
      sources.push({ kind: "quote", doc, quote });
    } else if (PASSAGE_LIST.test(locator)) {
      const ranges = locator.split(",").map((r): [number, number] => {
        const [a, b] = r.split("-").map((n) => Number(n.trim()));
        return [a, b ?? a];
      });
      sources.push({ kind: "passages", doc, ranges, ...(quote ? { quote } : {}) });
    } else {
      return null;
    }
  }
  return sources.length ? sources : null;
}

const sourceKey = (s: InlineSource): string =>
  s.kind === "passages"
    ? // One number per passage, whether or not a quote narrows it.
      `${s.doc}|p|${s.ranges.map(([a, b]) => `${a}-${b}`).join(",")}`
    : s.kind === "quote"
      ? `${s.doc}|q|${s.quote}`
      : s.kind === "cell"
        ? `${s.doc}|c|${s.sheet}!${s.cell}`
        : s.kind === "table"
          ? `table|${s.col}|${s.row}`
          : `case|${s.clusterId}|${s.quote}`;

export type InlineCitationEntry = {
  ref: number;
  source: InlineSource;
  /** Which read of its document the tag referred to (see latestReadIndex). */
  read?: number;
};

// ---------------------------------------------------------------------------
// What the model was shown this turn
// ---------------------------------------------------------------------------

type ReadText = { text: string; passages?: Passage[] };
/**
 * Per turn (keyed by its DocStore): each document's text as it was read,
 * every distinct read in order. A document read again after an edit has a
 * second entry; tags written before then still mean the first.
 */
const readTexts = new WeakMap<object, Map<string, ReadText[]>>();

/** Records the text a document was read as, so tags to it can be checked. */
export function rememberReadText(turn: object, docLabel: string, text: string): void {
  let byLabel = readTexts.get(turn);
  if (!byLabel) readTexts.set(turn, (byLabel = new Map()));
  const reads = byLabel.get(docLabel) ?? [];
  if (reads.at(-1)?.text !== text) reads.push({ text });
  byLabel.set(docLabel, reads);
}

/** Which read of a document a tag written now refers to: the latest. */
export function latestReadIndex(turn: object, docLabel: string): number | undefined {
  const reads = readTexts.get(turn)?.get(docLabel);
  return reads?.length ? reads.length - 1 : undefined;
}

function readAt(turn: object, docLabel: string, index?: number): ReadText | undefined {
  const reads = readTexts.get(turn)?.get(docLabel);
  if (!reads?.length) return undefined;
  return index === undefined ? reads.at(-1) : reads[index];
}

/** The text a document was last read as this turn, if it was read. */
export function readTextOf(turn: object, docLabel: string): string | undefined {
  return readAt(turn, docLabel)?.text;
}

/**
 * Whether a tag's source exists in the text its document was read as this
 * turn: false for a passage number or cell that is not there, undefined when
 * the document was not read this turn (a tag copied from an earlier answer
 * or a subagent's brief), which is resolved at the end instead.
 */
export function sourceExists(turn: object, source: InlineSource): boolean | undefined {
  if (source.kind === "case" || source.kind === "quote" || source.kind === "table") {
    return undefined;
  }
  const read = readAt(turn, source.doc);
  if (!read) return undefined;
  if (source.kind === "cell") {
    return spreadsheetCellValue(read.text, source.sheet, source.cell) !== null;
  }
  read.passages ??= segmentPassages(read.text);
  const count = read.passages.length;
  return source.ranges.every(([a, b]) => a >= 1 && b >= 1 && a <= count && b <= count);
}

/**
 * Longest a tag can run before it is treated as broken: an unquoted tag is
 * a label and passage numbers or a cell reference, and a quote is short.
 */
const MAX_UNQUOTED_TAG_CHARS = 120;
const MAX_QUOTED_TAG_CHARS = 400;
/** How long a word after passage numbers may run before it is taken as prose. */
const SHEET_NAME_WINDOW = 40;
/** How a tag can begin, after its `[[`. */
const TAG_START = /^\s*(?:doc-|case-|COL:|active-word-document)/;
/** Could `text` still grow into a tag start? (`[[`, `[[ d`, `[[doc`, …) */
const mayStartTag = (text: string) => {
  const start = text.replace(/^\s+/, "");
  return TAG_PREFIXES.some((prefix) => prefix.startsWith(start));
};
/**
 * The citation a broken tag still makes: its label, then passage numbers or
 * a closed quote. What follows it is the model's prose.
 */
const QUOTED = String.raw`["“][^"”\n]*["”]`;
const SALVAGE = new RegExp(
  String.raw`^\s*(${DOC}\s+\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*(?:\s+${QUOTED})?|${DOC}\s+${QUOTED}|case-\d+\s+${QUOTED}|${TABLE}(?:\s+${QUOTED})?)`,
);
const LABEL_AT_START = new RegExp(String.raw`^\s*(?:${DOC}|case-\d+|${TABLE})\s*["“]?`);
/**
 * Prose has begun inside an unclosed tag: a word after its passage numbers
 * or after its closed quote, or straight after a case label (a case is
 * always cited with a quote). A word straight after a document label may
 * be a sheet name, so that case waits for `!` or a limit.
 */
const PROSE_AFTER_TAG = new RegExp(
  String.raw`^\s*(?:(?:${DOC}\s+\d[\d\s,-]*?|(?:${DOC}\s+(?:\d[\d\s,-]*)?|case-\d+\s+|${TABLE}\s+)${QUOTED}|${TABLE})\s+|case-\d+\s+)[A-Za-z(£$]$`,
);

/**
 * Text that cannot end a clause: a quoted tag right after it was meant to
 * be read, as in "The landlord is [[COL:0 ROW:0 "Harbourside Ltd"]]".
 */
const UNFINISHED_CLAUSE =
  /(?:\b(?:is|are|was|were|be|been|being|of|to|by|for|with|from|than|the|a|an|and|or|that|giving|give|gives|have|has|had|pay|pays|paid|include|includes|including|on|in|at|as|under|between|within|named|called|states|provides|says|reads|means)|:\**)\s*$/i;
/** How much shown text a quote is looked for in, before its tag. */
const QUOTE_CONTEXT_CHARS = 300;

/**
 * Rewrites a streamed answer: each `[[...]]` tag becomes `[N]` markers,
 * numbered by first appearance and reused for a repeated source.
 *
 * Text is held back only while a tag may be in progress. A tag the model
 * does not close properly ends at a single `]`, a line break, another `[[`
 * or its length limit; the citation it still makes is kept and the rest of
 * its text is returned to the prose, so a slip never deletes what the model
 * wrote and never shows raw tag syntax.
 */
export function createInlineCitationStream(options: {
  maxCitations: number;
  /** See sourceExists: a source known not to exist gets no marker. */
  exists?: (source: InlineSource) => boolean | undefined;
  /** Which read of its document a source refers to now (latestReadIndex). */
  readOf?: (source: InlineSource) => number | undefined;
}) {
  const refByKey = new Map<string, number>();
  const entries: InlineCitationEntry[] = [];
  let buffer = "";
  let malformed = 0;
  let missing = 0;
  let quoteAsText = 0;
  // The end of what has been shown, for a tag to look back at.
  let shown = "";
  // A tag broke off before its "]]": the "]]" the model then writes on the
  // same line closes nothing, and is removed rather than shown.
  let strayClose = false;

  /** Prose, without the "]]" a broken tag left behind on its line. */
  const prose = (text: string): string => {
    if (!strayClose) return text;
    const close = text.indexOf("]]");
    const line = text.indexOf("\n");
    if (line >= 0 && (close < 0 || line < close)) {
      strayClose = false;
      return text;
    }
    if (close < 0) return text;
    strayClose = false;
    return text.slice(0, close) + text.slice(close + 2);
  };

  const markersFor = (sources: InlineSource[]): string => {
    let out = "";
    for (const source of sources) {
      if (options.exists?.(source) === false) {
        missing += 1;
        continue;
      }
      // The same passage number can name a different clause on the next read.
      const read = options.readOf?.(source);
      const key = `${read ?? ""}|${sourceKey(source)}`;
      let ref = refByKey.get(key);
      if (ref === undefined) {
        if (entries.length >= options.maxCitations) continue;
        ref = entries.length + 1;
        refByKey.set(key, ref);
        entries.push({ ref, source, ...(read !== undefined ? { read } : {}) });
      }
      out += `[${ref}]`;
    }
    return out;
  };

  /**
   * A tag's markers, with the space before it only if a marker is left.
   * When a quoted tag stands where the sentence still needs words ("The
   * landlord is [[... "Harbourside Ltd"]]") and the sentence does not say
   * them, the quote is shown before the marker: the model meant it to be
   * read, and the reader never sees inside a tag.
   */
  const tagOutput = (space: string, sources: InlineSource[] | null, before: string) => {
    const markers = sources ? markersFor(sources) : "";
    if (!markers) return "";
    const quote =
      sources!.length === 1 && "quote" in sources![0] ? sources![0].quote : undefined;
    if (quote && UNFINISHED_CLAUSE.test(before)) {
      const context = norm(before.slice(-QUOTE_CONTEXT_CHARS));
      if (!context.includes(norm(quote))) {
        quoteAsText += 1;
        return `${space || " "}${quote} ${markers}`;
      }
    }
    return space + markers;
  };

  /** A tag that ended without `]]`: its citation, then its text as prose. */
  const brokenTag = (space: string, body: string, before: string): string => {
    malformed += 1;
    strayClose = true;
    const head = body.match(SALVAGE);
    if (head) {
      let rest = body.slice(head[0].length);
      if (rest.startsWith("]")) rest = rest.slice(1);
      return tagOutput(space, parseCitationTag(head[1]), before) + rest;
    }
    // No citation can be read from it: keep the words, drop the label.
    return space + body.replace(LABEL_AT_START, "");
  };

  /**
   * Where the tag that opens `text` (with its `[[`) ends: `close` for `]]`,
   * `broken` where it stops without one, or `pending` if it may continue.
   */
  const tagEnd = (
    text: string,
    atEnd: boolean,
  ): { kind: "close"; at: number } | { kind: "broken"; at: number } | { kind: "pending" } => {
    let quoted = false;
    let quoteStart = -1;
    // Where prose seems to start after the passage numbers. A sheet name can
    // start with a number too ("2025 Budget!B7"), so the break waits a few
    // characters for a "!"; then it falls back to this point.
    let proseAt = -1;
    const broken = (i: number) => ({ kind: "broken" as const, at: proseAt >= 0 ? proseAt : i });
    for (let i = 2; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        // A quote the model forgot to close still ends with its tag ("]]"),
        // and never runs into the next tag ("[[") or line.
        if (ch === '"' || ch === "”") quoted = false;
        else if (ch === "]" && text[i + 1] === "]") return { kind: "close", at: i };
        else if (ch === "]" && i + 1 >= text.length && !atEnd) return { kind: "pending" };
        else if (
          ch === "\n" ||
          (ch === "[" && text[i + 1] === "[") ||
          i - quoteStart > MAX_QUOTED_TAG_CHARS
        ) {
          return broken(i);
        }
        continue;
      }
      if (ch === '"' || ch === "“") {
        quoted = true;
        quoteStart = i;
        continue;
      }
      if (ch === "]") {
        if (i + 1 >= text.length) return atEnd ? broken(i) : { kind: "pending" };
        return text[i + 1] === "]" ? { kind: "close", at: i } : broken(i);
      }
      if (ch === "\n" || (ch === "[" && text[i + 1] === "[")) return broken(i);
      if (i - 2 > MAX_UNQUOTED_TAG_CHARS) return broken(i);
      if (ch === "!") proseAt = -1; // a sheet name after all
      if (proseAt >= 0 && i - proseAt >= SHEET_NAME_WINDOW) return broken(i);
      if (proseAt < 0 && PROSE_AFTER_TAG.test(text.slice(2, i + 1))) proseAt = i;
    }
    return atEnd ? broken(text.length) : { kind: "pending" };
  };

  const scan = (atEnd: boolean): string => {
    let out = "";
    for (;;) {
      const open = buffer.indexOf("[[");
      if (open < 0) {
        // Hold trailing spaces (a tag may follow), a trailing "[", and a
        // trailing "]" that may be half of a stray "]]".
        buffer = prose(buffer);
        // Removing a stray "]]" can join "[" and "[": scan again.
        if (buffer.includes("[[")) continue;
        const tail = strayClose ? /\s*[[\]]?$/ : /\s*\[?$/;
        const hold = atEnd ? 0 : (buffer.match(tail)?.[0].length ?? 0);
        out += buffer.slice(0, buffer.length - hold);
        buffer = buffer.slice(buffer.length - hold);
        return out;
      }
      const before = prose(buffer.slice(0, open));
      const space = before.match(/\s*$/)![0];
      const rest = buffer.slice(open);
      const after = rest.slice(2);
      if (!TAG_START.test(after)) {
        if (!atEnd && mayStartTag(after)) {
          out += before.slice(0, before.length - space.length);
          buffer = space + rest;
          return out;
        }
        // Not a tag: ordinary text.
        out += before + "[[";
        buffer = after;
        continue;
      }
      out += before.slice(0, before.length - space.length);
      const end = tagEnd(rest, atEnd);
      if (end.kind === "pending") {
        buffer = space + rest;
        return out;
      }
      if (end.kind === "close") {
        const inner = rest.slice(2, end.at);
        const sources = parseCitationTag(inner);
        if (sources) {
          out += tagOutput(space, sources, shown + out);
        } else {
          // Closed but unreadable: keep a citation it still makes; the rest
          // was inside the tag, not prose, so it is dropped.
          malformed += 1;
          const head = inner.match(SALVAGE);
          out += head ? tagOutput(space, parseCitationTag(head[1]), shown + out) : "";
        }
        buffer = rest.slice(end.at + 2);
        continue;
      }
      // Broken: everything up to the break is the tag's text. A lone "]"
      // that ended it belonged to the tag.
      out += brokenTag(space, rest.slice(2, end.at), shown + out);
      buffer = rest.slice(rest[end.at] === "]" ? end.at + 1 : end.at);
    }
  };

  const remember = (out: string) => {
    shown = (shown + out).slice(-QUOTE_CONTEXT_CHARS);
    return out;
  };

  const push = (delta: string): string => {
    buffer += delta;
    return remember(scan(false));
  };

  /** The end of the answer: whatever is held is resolved now. */
  const flush = (): string => {
    const out = scan(true);
    buffer = "";
    return remember(out);
  };

  return {
    push,
    flush,
    entries: (): readonly InlineCitationEntry[] => entries,
    /** Tags that were not closed or could not be read. */
    malformedCount: () => malformed,
    /** Tags dropped because their passage or cell was not in the text read. */
    missingCount: () => missing,
    /** Quoted tags shown as text because the sentence needed their words. */
    quoteAsTextCount: () => quoteAsText,
  };
}

/** Rewrites a complete text in one pass (stored answers, subagent briefs). */
export function rewriteInlineCitations(text: string, maxCitations: number) {
  const stream = createInlineCitationStream({ maxCitations });
  const visible = stream.push(text) + stream.flush();
  return { visible, entries: stream.entries(), malformed: stream.malformedCount() };
}

// ---------------------------------------------------------------------------
// Resolution into raw citation objects
// ---------------------------------------------------------------------------

type InlineQuote = {
  quote: string;
  verification?: QuoteVerification;
  page?: number;
  sheet?: string;
  cell?: string;
};

/** Raw citation built by the server from the model's inline tag. */
export type RawCitation = Record<string, unknown> & { ref: number; quotes?: InlineQuote[] };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The value of one spreadsheet cell from its `## Sheet:` table rendering. */
export function spreadsheetCellValue(text: string, sheet: string, cell: string): string | null {
  const first = cell.split(":")[0];
  const m = first.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  const col = m[1].toUpperCase();
  const row = m[2];
  const sections = text.split(/^## Sheet: /m).slice(1);
  const section = sections.find((s) => norm(s.split("\n", 1)[0]) === norm(sheet));
  if (!section) return null;
  const lines = section.split("\n").filter((l) => l.startsWith("|"));
  if (lines.length < 2) return null;
  const cells = (line: string) => line.split("|").slice(1, -1).map((c) => c.trim());
  const header = cells(lines[0]);
  const colIndex = header.indexOf(col);
  if (colIndex < 0) return null;
  const rowLine = lines.slice(2).find((l) => cells(l)[0] === row);
  if (!rowLine) return null;
  const value = cells(rowLine)[colIndex]?.replace(/\s*⟨merged [^⟩]*⟩/, "").trim();
  return value ? value : null;
}

type DocSource = Exclude<InlineSource, { kind: "case" } | { kind: "table" }>;
const isDocSource = (source: InlineSource): source is DocSource =>
  source.kind !== "case" && source.kind !== "table";

/** A document's text as the model was shown it, and as it is now. */
type DocTexts = { shown: string; current: string };

export type ResolveOptions = {
  /**
   * The turn whose reads tags refer to (see rememberReadText). A passage
   * number means the passage in the text the model was shown; if the
   * document changed since (an edit in this turn), the passage is found in
   * its current text by aligning the two.
   */
  turn?: object;
  /**
   * Cut quotes taken from passages to one line of at most this many
   * characters, for a client that searches for them (Word's search takes
   * at most 255 characters and no line breaks).
   */
  maxQuoteChars?: number;
  isPdf?: (doc: string) => boolean;
};

/**
 * Turns the tags an answer used into raw citations, reading each cited
 * document's text once through `readSourceText`. A tag that names a passage
 * or cell that does not exist is left out, and counted. Table and case
 * tags are not document sources; table tags resolve with
 * resolveTableCitations.
 */
export async function resolveInlineCitations(
  entries: readonly InlineCitationEntry[],
  readSourceText: (docLabel: string) => Promise<string>,
  options: ResolveOptions = {},
): Promise<{ citations: RawCitation[]; unresolved: number }> {
  const current = new Map<string, string>();
  const docs = [...new Set(entries.flatMap(({ source }) => (isDocSource(source) ? [source.doc] : [])))];
  await Promise.all(
    docs.map(async (doc) => current.set(doc, await readSourceText(doc).catch(() => ""))),
  );
  return resolveFromTexts(
    entries,
    (doc, read) => {
      const now = current.get(doc) ?? "";
      const shown = options.turn ? readAt(options.turn, doc, read)?.text : undefined;
      return { shown: shown ?? now, current: now };
    },
    options,
  );
}

/**
 * The citations that can be built now from the text each document was read
 * as this turn, without reading anything: sent while the answer streams so
 * a marker can be opened before the answer ends. Sources of documents not
 * read this turn wait for the end of the answer.
 */
export function resolveReadCitations(
  turn: object,
  entries: readonly InlineCitationEntry[],
  options: Omit<ResolveOptions, "turn"> = {},
): RawCitation[] {
  const known = entries.filter(
    ({ source, read }) => isDocSource(source) && readAt(turn, source.doc, read) !== undefined,
  );
  return resolveFromTexts(
    known,
    (doc, read) => {
      const text = readAt(turn, doc, read)?.text ?? "";
      return { shown: text, current: text };
    },
    options,
  ).citations;
}

/** One line of `text`, cut at a word to at most `max` characters. */
export function locatableQuote(text: string, max: number): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/** Largest alignment table the exact LCS is computed for. */
const MAX_ALIGNMENT_CELLS = 4_000_000;

/**
 * Where each passage of an earlier version of a document is in its current
 * version, for passages whose text is unchanged (matched in order, by the
 * longest common subsequence). A passage the edit changed or removed has no
 * entry: its new wording is not what the model read, so it is never
 * offered as the evidence the model cited.
 */
export function alignPassages(before: Passage[], after: Passage[]): Map<number, Passage> {
  const a = before.map((p) => norm(p.text));
  const b = after.map((p) => norm(p.text));
  const map = new Map<number, Passage>();
  if (a.length * b.length <= MAX_ALIGNMENT_CELLS) {
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      if (a[i] === b[j]) map.set(before[i++].id, after[j++]);
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
      else j++;
    }
  } else {
    // Too large to align exactly: match identical passages in order.
    let j = 0;
    for (let i = 0; i < a.length; i++) {
      const k = b.indexOf(a[i], j);
      if (k >= 0) {
        map.set(before[i].id, after[k]);
        j = k + 1;
      }
    }
  }
  return map;
}

/** Only native page text has a corresponding position in the PDF.js text layer. */
function pdfPageStarts(text: string): number[] {
  if (!text.startsWith("[Page 1]\n")) return [];
  const starts: number[] = [];
  for (const header of text.matchAll(PAGE_LINE)) {
    if (Number(header[1]) !== starts.length + 1) return [];
    starts.push(header.index + header[0].length);
  }
  return starts;
}

function pinnedPdfQuote(
  text: string, pageStart: number, passageStart: number, slice: string, quote: string, current: boolean,
): InlineQuote | undefined {
  // A narrowed tag may have folded whitespace or changed case. Recover the
  // exact spelling from inside the chosen passage, never from another copy.
  let local = slice.indexOf(quote);
  if (local < 0) {
    const words = quote.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const match = new RegExp(words.join("\\s+"), "i").exec(slice);
    if (!match) return;
    local = match.index;
    quote = match[0];
  }
  const start = passageStart + local;
  const end = start + quote.length;
  // Form values are inserted into the extraction, but are absent from the
  // viewer's text layer. Their letters would shift every subsequent offset.
  const prefix = text.slice(pageStart, end);
  if (!/[a-zA-Z0-9]/.test(quote) || /\[Page \d+ form fields\]|\[[^\[\]]*?: /.test(prefix)) return;
  return {
    quote,
    verification: {
      verified: current,
      start_char: start,
      end_char: end,
      pdf_text_offset: text.slice(pageStart, start).replace(/[^a-zA-Z0-9]/g, "").length,
    },
  };
}

function resolveFromTexts(
  entries: readonly InlineCitationEntry[],
  textsOf: (doc: string, read?: number) => DocTexts,
  options: ResolveOptions,
): { citations: RawCitation[]; unresolved: number } {
  type Docs = {
    texts: DocTexts;
    pdfStarts: number[];
    shownPdfStarts: number[];
    shown: Passage[];
    current: Passage[];
    /** Shown passage id → the same, unchanged passage in the current text. */
    moved: Map<number, Passage> | null;
  };
  const byRead = new Map<string, Docs>();
  const docsOf = (doc: string, read?: number): Docs => {
    const key = `${doc}#${read ?? "last"}`;
    let d = byRead.get(key);
    if (!d) {
      const texts = textsOf(doc, read);
      const shown = segmentPassages(texts.shown);
      const same = texts.shown === texts.current;
      const current = same ? shown : segmentPassages(texts.current);
      const isPdf = options.isPdf?.(doc);
      const pdfStarts = isPdf ? pdfPageStarts(texts.current) : [];
      const shownPdfStarts = isPdf && !same ? pdfPageStarts(texts.shown) : pdfStarts;
      d = { texts, pdfStarts, shownPdfStarts, shown, current, moved: same ? null : alignPassages(shown, current) };
      byRead.set(key, d);
    }
    return d;
  };
  const short = (quote: string) =>
    options.maxQuoteChars ? locatableQuote(quote, options.maxQuoteChars) : quote;

  const citations: RawCitation[] = [];
  let unresolved = 0;
  for (const { ref, source, read } of entries) {
    if (source.kind === "table") continue;
    if (source.kind === "case") {
      citations.push({ ref, cluster_id: source.clusterId, quotes: [{ quote: source.quote }] });
      continue;
    }
    const docs = docsOf(source.doc, read);
    if (source.kind === "cell") {
      const value = spreadsheetCellValue(docs.texts.current, source.sheet, source.cell);
      if (value === null) {
        unresolved += 1;
        continue;
      }
      citations.push({
        ref,
        doc_id: source.doc,
        quotes: [{ sheet: source.sheet, cell: source.cell, quote: value }],
      });
      continue;
    }
    if (source.kind === "quote") {
      // Locate the page the quoted words are on, when the text is paged.
      const target = norm(source.quote);
      const home = docs.current.find((p) => norm(p.text).includes(target));
      citations.push({
        ref,
        doc_id: source.doc,
        quotes: [{ ...(home?.page != null ? { page: home.page } : {}), quote: short(source.quote) }],
      });
      continue;
    }
    // A range is valid only when both ends name passages that exist, as the
    // check made while streaming requires; it never resolves to a clipped
    // subset.
    const count = docs.shown.length;
    const valid = source.ranges.every(([a, b]) => a >= 1 && b >= 1 && a <= count && b <= count);
    if (!valid) {
      unresolved += 1;
      continue;
    }
    // Each passage the tag names: where it is now if it is unchanged (an
    // edit may have moved it), else as the model was shown it, which
    // verification against the current text then flags.
    type Located = { passage: Passage; text: string };
    const located: Located[] = [];
    for (const [from, to] of source.ranges) {
      const picked = docs.shown.filter((p) => p.id >= Math.min(from, to) && p.id <= Math.max(from, to));
      for (const p of picked) {
        const now = docs.moved ? docs.moved.get(p.id) : p;
        located.push(
          now
            ? { passage: now, text: docs.texts.current }
            : { passage: p, text: docs.texts.shown },
        );
      }
    }
    // Adjacent passages of one page and text become one contiguous quote.
    const quotes: InlineQuote[] = [];
    for (let i = 0; i < located.length; ) {
      let j = i;
      while (
        j + 1 < located.length &&
        located[j + 1].text === located[i].text &&
        located[j + 1].passage.page === located[i].passage.page &&
        located[j + 1].passage.id === located[j].passage.id + 1
      ) {
        j++;
      }
      const { passage, text } = located[i];
      const slice = text.slice(passage.start, located[j].passage.end);
      const quoteInside =
        source.quote && norm(slice).includes(norm(source.quote)) ? source.quote : null;
      const quote = short(quoteInside ?? slice);
      const current = text === docs.texts.current;
      const pageStarts = current ? docs.pdfStarts : docs.shownPdfStarts;
      const pageStart = passage.page === null ? undefined : pageStarts[passage.page - 1];
      const pinned = pageStart === undefined ? undefined
        : pinnedPdfQuote(text, pageStart, passage.start, slice, quote, current);
      quotes.push({
        ...(passage.page != null ? { page: passage.page } : {}),
        ...(pinned ?? { quote }),
      });
      i = j + 1;
    }
    if (quotes.length === 0) {
      unresolved += 1;
      continue;
    }
    citations.push({ ref, doc_id: source.doc, quotes: quotes.slice(0, 3) });
  }
  return { citations, unresolved };
}

/** What resolving a table tag needs from a tabular review. */
export type TableCells = {
  columns: { index: number; name: string }[];
  documents: { id: string; filename: string }[];
  cells: Map<string, { summary?: string | null } | null>;
};

/**
 * A table cell's summary as the model read it: undefined if it was not
 * read with read_table_cells, null if it is empty or not in the review.
 * Cells are cached by the column's stored index, not its position.
 */
export function tableCellSummary(store: TableCells, col: number, row: number): string | null | undefined {
  const column = store.columns[col];
  const document = store.documents[row];
  if (!column || !document) return null;
  const cell = store.cells.get(`${column.index}:${document.id}`);
  if (cell === undefined) return undefined;
  return cell?.summary?.trim() ? cell.summary : null;
}

/** Whether a table tag can be cited: its cell was read and has content. */
export function tableSourceExists(store: TableCells, source: InlineSource): boolean | undefined {
  if (source.kind !== "table") return undefined;
  return typeof tableCellSummary(store, source.col, source.row) === "string";
}

/**
 * The tabular citations an answer's table tags make, in the shape tabular
 * chat stores. A quote narrowing a cell must occur in its summary; the
 * citation otherwise quotes the cell's summary.
 */
export function resolveTableCitations(
  entries: readonly InlineCitationEntry[],
  store: TableCells,
): { citations: Record<string, unknown>[]; unresolved: number } {
  const citations: Record<string, unknown>[] = [];
  let unresolved = 0;
  for (const { ref, source } of entries) {
    if (source.kind !== "table") continue;
    const summary = tableCellSummary(store, source.col, source.row);
    if (typeof summary !== "string") {
      unresolved += 1;
      continue;
    }
    const narrowed =
      source.quote && norm(summary).includes(norm(source.quote)) ? source.quote : null;
    citations.push({
      type: "tabular_citation",
      ref,
      col_index: source.col,
      row_index: source.row,
      col_name: store.columns[source.col]!.name,
      doc_name: store.documents[source.row]!.filename,
      quote: narrowed ?? summary,
      verified: true,
    });
  }
  return { citations, unresolved };
}

/**
 * What follows the document label in a source's tag, such as `12-13` or
 * `Rent schedule!D4`: stored with the citation so a later turn can show the
 * marker as the tag it stood for. Null for cases and quote-only tags, which
 * are replayed from their quote.
 */
export function inlineLocator(source: InlineSource): string | null {
  if (source.kind === "passages") {
    return source.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
  }
  if (source.kind === "cell") return `${source.sheet}!${source.cell}`;
  return null;
}

/** Adds each citation's tag locator (see inlineLocator), matched by ref. */
export function withInlineLocators(
  citations: unknown[],
  entries: readonly InlineCitationEntry[],
): unknown[] {
  const byRef = new Map(entries.map((e) => [e.ref, inlineLocator(e.source)]));
  return citations.map((c) => {
    const ref = (c as { ref?: unknown })?.ref;
    const locator = typeof ref === "number" ? byRef.get(ref) : null;
    return locator ? { ...(c as object), inline_locator: locator } : c;
  });
}

// ---------------------------------------------------------------------------
// Text that leaves the chat
// ---------------------------------------------------------------------------

const PASSAGE_LABEL = /\{(\d{1,5})\}/g;
const CLOSED_TAG = /([ \t]*)\[\[([^[\]\n]*)\]\]/g;
/** The start of a tag left open: everything up to its line's end or the next tag. */
const UNCLOSED_TAG = new RegExp(
  String.raw`([ \t]*)\[\[(\s*(?:${DOC}|case-\d+|COL:\d+)(?:(?!\[\[)[^\n])*)`,
  "g",
);

/** How a cited source reads outside the chat: "Lease.pdf, p. 5". */
export function plainReference(
  turn: object,
  source: InlineSource,
  names: { filenameOf: (doc: string) => string | undefined; caseNameOf?: (clusterId: number) => string | undefined },
): string | null {
  if (source.kind === "case") return names.caseNameOf?.(source.clusterId) ?? null;
  if (source.kind === "table") return null;
  const filename = names.filenameOf(source.doc);
  if (!filename) return null;
  if (source.kind === "cell") return `${filename}, ${source.sheet}!${source.cell}`;
  if (source.kind === "passages") {
    const read = readAt(turn, source.doc);
    if (read) {
      read.passages ??= segmentPassages(read.text);
      const first = read.passages.find((p) => p.id === source.ranges[0][0]);
      if (first?.page != null) return `${filename}, p. ${first.page}`;
    }
  }
  return filename;
}

/**
 * Is `{id}` followed by `following` a passage label the model copied from a
 * document it read this turn? Only then is it removed: a `{1}` that is not
 * the start of passage 1 (LaTeX, a template placeholder) is left alone.
 */
function isCopiedLabel(turn: object, id: number, following: string): boolean {
  const start = norm(following.slice(0, 24));
  if (!start) return false;
  for (const read of [...(readTexts.get(turn)?.values() ?? [])].flat()) {
    read.passages ??= segmentPassages(read.text);
    const passage = read.passages[id - 1];
    if (!passage) continue;
    const head = norm(passage.text.slice(0, 24));
    if (head.startsWith(start) || start.startsWith(head)) return true;
  }
  return false;
}

/**
 * Text bound for a document or another tool, with the chat's citation
 * markup removed: passage labels copied from what the model read are
 * dropped, and each citation tag becomes a plain reference in parentheses,
 * or nothing if its source cannot be named. Other text is not touched.
 */
export function withoutCitationMarkup(
  turn: object,
  text: string,
  reference: (source: InlineSource) => string | null,
): string {
  if (!text.includes("[[") && !text.includes("{")) return text;
  return text
    .replace(CLOSED_TAG, (tag, space: string, inner: string) => {
      const sources = parseCitationTag(inner);
      if (!sources) return CITATION_START.test(inner) ? "" : tag;
      const refs = [...new Set(sources.map(reference).filter((r): r is string => !!r))];
      return refs.length ? `${space}(${refs.join("; ")})` : "";
    })
    .replace(UNCLOSED_TAG, (_tag, space: string, body: string) => {
      // The same recovery as the stream: the citation the tag still makes
      // becomes a reference, and the words after it are kept.
      const head = body.match(SALVAGE);
      if (!head) return space + body.replace(LABEL_AT_START, "");
      let rest = body.slice(head[0].length);
      if (rest.startsWith("]")) rest = rest.slice(1);
      const sources = parseCitationTag(head[1]) ?? [];
      const refs = [...new Set(sources.map(reference).filter((r): r is string => !!r))];
      return (refs.length ? `${space}(${refs.join("; ")})` : "") + rest;
    })
    .replace(PASSAGE_LABEL, (label, id: string, offset: number, whole: string) =>
      isCopiedLabel(turn, Number(id), whole.slice(offset + label.length)) ? "" : label,
    );
}

/** Applies `fn` to every string inside a tool call's input. */
export function mapInputStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapInputStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapInputStrings(v, fn)]),
    );
  }
  return value;
}

/**
 * An earlier answer without its [N] markers. In inline mode a marker the
 * model sees without its citation teaches it to write markers, not tags.
 */
export function stripCitationMarkers(text: string): string {
  return text.replace(/[ \t]?\[\d{1,3}\]/g, "");
}

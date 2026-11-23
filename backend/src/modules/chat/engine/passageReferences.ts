import { randomBytes } from "node:crypto";
import type { DocIndex } from "./types";
import { createCitation } from "./citations";

// Bounded independently of how many documents the assistant reads. Longer
// passages and sources beyond this budget retain the explicit quote tool.
const MAX_PASSAGES = 4096;
const MAX_PASSAGE_CHARS = 600;
type Source = DocIndex[string];
type Passage = {
  label: string;
  source: Source;
  quote: string;
  page: number;
  start: number;
  pdfTextOffset?: number;
};

/** One model run. Only passages exposed by its own successful reads get handles. */
export class PassageReferences {
  private readonly prefix = "p" + randomBytes(4).toString("hex") + ":";
  private readonly passages = new Map<string, Passage>();
  private readonly used = new Map<string, number>();
  private pending = "";
  unknown = 0;

  constructor(private readonly insert: (row: Record<string, unknown>) => number | null) {}

  annotate(text: string, label: string, source: Source): string {
    if (this.passages.size >= MAX_PASSAGES) return text;
    const isPdf = /\.pdf$/i.test(source.filename);
    // The OCR notice is added for the model and shifts all character offsets.
    // Use the quote tool for this read so offsets always refer to source text.
    if (isPdf && /^\[[^\n]*\bOCR\.[^\n]*\]/.test(text)) return text;
    // A line in a PDF can itself say "[Page N]". Only use the extractor's
    // sequential page headers, starting at the beginning of the read.
    if (isPdf) {
      if (!text.startsWith("[Page 1]\n")) return text;
      let expectedPage = 1;
      for (const match of text.matchAll(/^\[Page (\d+)\]$/gm)) {
        if (Number(match[1]) !== expectedPage++) return text;
      }
    }
    let page = 1;
    let pdfOffset = 0;
    let inFormFields = false;
    return text.replace(/[^\r\n]+/g, (line: string, offset: number) => {
      if (this.passages.size >= MAX_PASSAGES) return line;
      const quote = line.trim();
      const heading = isPdf && /^\[Page (\d+)\]$/.exec(line);
      if (heading) {
        page = Number(heading[1]);
        pdfOffset = 0;
        inFormFields = false;
        return line;
      }
      if (isPdf && /^\[Page \d+ form fields\]$/.test(quote)) inFormFields = true;
      const pdfTextOffset = isPdf && !inFormFields ? pdfOffset : undefined;
      // PdfView indexes PDF.js spans in reading order using ASCII letters and digits.
      if (isPdf) {
        const length = line.replace(/[^a-zA-Z0-9]/g, "").length;
        if (!length) return line;
        pdfOffset += length;
      }
      if (inFormFields || !quote || /^\[.*\]$/.test(quote) ||
          quote.length > MAX_PASSAGE_CHARS) {
        return line;
      }
      const id = this.prefix + (this.passages.size + 1);
      this.passages.set(id, { label, source, quote, page, pdfTextOffset, start: offset + line.indexOf(quote) });
      return "[[" + id + "]] " + line;
    });
  }

  private resolve(id: string): string {
    const prior = this.used.get(id);
    if (prior !== undefined) return "[" + prior + "]";
    const p = this.passages.get(id);
    if (p) {
      const { label, quote, page, start, source } = p;
      const citation = createCitation(
        { kind: "document", ref: 0, doc_id: label, page, quote, quotes: [{ page, quote }] },
        { [label]: source },
      );
      if (citation?.kind === "document") {
        const verification = {
          verified: true, start_char: start, end_char: start + quote.length,
          ...(p.pdfTextOffset === undefined ? {} : { pdf_text_offset: p.pdfTextOffset }),
        };
        const ref = this.insert({
          ...citation,
          verified: true,
          quotes: [{ page, quote, verification }],
          document: {
            ...citation.document,
            quotes: citation.document.quotes.map(q => ({ ...q, verification })),
          },
        });
        if (ref !== null) {
          this.used.set(id, ref);
          return "[" + ref + "]";
        }
      }
    }
    this.unknown++;
    return "[source unavailable]";
  }

  /** Hold only a possible token prefix, including a single bracket split off a delta. */
  push(delta: string): string {
    const text = this.pending + delta;
    const tail = /(?:\[$|\[\[(?:p(?:[a-f0-9]{0,8}(?::\d{0,6}\]?)?)?)?$)/.exec(text);
    this.pending = tail?.[0] ?? "";
    return text.slice(0, text.length - this.pending.length)
      .replace(/\[\[(p[a-f0-9]{8}:\d{1,6})\]\]/g, (_, id: string) => this.resolve(id));
  }

  flush(): string {
    const tail = this.pending;
    this.pending = "";
    if (tail.startsWith("[[p")) {
      this.unknown++;
      return "[source unavailable]";
    }
    return tail;
  }

  get count() {
    return this.used.size;
  }
}

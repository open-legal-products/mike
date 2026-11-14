/**
 * Page-aware chunking of stored document text for semantic retrieval.
 *
 * Input is the text published in document_version_texts: PDF/legacy Office
 * text carries `[Page N]` markers (also after OCR), DOCX/PPTX/spreadsheets do
 * not. Chunks follow paragraph boundaries, stay within `chunkChars`, overlap
 * by `overlap` characters, and record their page range and character offsets
 * into the original text so a hit can be cited and re-read exactly.
 *
 * Shared kernel (`lib/`), pure and dependency-free.
 */

export type TextChunk = {
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  startChar: number;
  endChar: number;
  content: string;
};

type Segment = { start: number; end: number; page: number | null };

const PAGE_MARKER = /^\[Page (\d+)(?: form fields)?\]$/;

/** Split text into paragraph segments with absolute offsets and page numbers. */
function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let page: number | null = null;
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g; // paragraphs separated by blank lines
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const lines = raw.split("\n");
    let offset = m.index;
    let buffer: { start: number; end: number } | null = null;
    for (const line of lines) {
      const marker = PAGE_MARKER.exec(line.trim());
      if (marker) {
        if (buffer) out.push({ ...buffer, page });
        buffer = null;
        page = Number(marker[1]);
      } else if (line.trim()) {
        buffer = buffer ? { start: buffer.start, end: offset + line.length } : { start: offset, end: offset + line.length };
      }
      offset += line.length + 1;
    }
    if (buffer) out.push({ ...buffer, page });
  }
  return out;
}

export function chunkDocumentText(
  text: string,
  options: { chunkChars?: number; overlap?: number; maxChunks?: number } = {},
): TextChunk[] {
  const chunkChars = Math.max(200, options.chunkChars ?? 1800);
  const overlap = Math.min(Math.max(0, options.overlap ?? 200), Math.floor(chunkChars / 2));
  const maxChunks = options.maxChunks ?? Number.MAX_SAFE_INTEGER;

  // Hard-split paragraphs longer than chunkChars on whitespace. Consecutive
  // pieces of one paragraph overlap by `overlap` characters, so text across a
  // hard cut still appears together in at least one chunk. Progress is
  // guaranteed: cut > start + chunkChars / 2 and overlap <= chunkChars / 2.
  const segs: Segment[] = [];
  for (const s of segments(text)) {
    let start = s.start;
    while (s.end - start > chunkChars) {
      let cut = start + chunkChars;
      const space = text.lastIndexOf(" ", cut);
      if (space > start + chunkChars / 2) cut = space;
      segs.push({ start, end: cut, page: s.page });
      let next = Math.max(start + 1, cut - overlap);
      if (overlap > 0) {
        // Begin the overlapping piece on a word boundary when one is near.
        const boundary = text.indexOf(" ", next);
        if (boundary !== -1 && boundary < cut) next = boundary;
      } else {
        next = cut;
      }
      start = next;
      while (start < s.end && /\s/.test(text[start]!)) start++;
    }
    if (s.end > start) segs.push({ start, end: s.end, page: s.page });
  }

  const chunks: TextChunk[] = [];
  let i = 0;
  while (i < segs.length && chunks.length < maxChunks) {
    const first = segs[i]!;
    let j = i;
    while (j + 1 < segs.length && segs[j + 1]!.end - first.start <= chunkChars) j++;
    const last = segs[j]!;
    const pages = segs.slice(i, j + 1).map((s) => s.page).filter((p): p is number => p !== null);
    chunks.push({
      chunkIndex: chunks.length,
      pageStart: pages.length ? Math.min(...pages) : null,
      pageEnd: pages.length ? Math.max(...pages) : null,
      startChar: first.start,
      endChar: last.end,
      // Offsets cover the original span; page markers inside it are dropped
      // from the embedded content (the page range already carries them).
      content: text.slice(first.start, last.end).replace(/^\[Page \d+(?: form fields)?\][ \t]*\n?/gm, "").trim(),
    });
    if (j + 1 >= segs.length) break;
    // Next chunk starts at the latest segment that keeps ~overlap chars of context.
    let next = j + 1;
    while (next - 1 > i && last.end - segs[next - 1]!.start <= overlap) next--;
    i = next;
  }
  return chunks.filter((c) => c.content.length > 0);
}

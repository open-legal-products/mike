import JSZip from "jszip";

export type PlaybookSourceRef = {
  id: string;
  kind: "paragraph" | "table_cell";
  text: string;
  style: string | null;
  level: number | null;
  table?: number;
  row?: number;
  column?: number;
};

export type PlaybookWordStructure = {
  format: "docx";
  blocks: Array<
    | {
        kind: "paragraph";
        sourceRef: string;
        text: string;
        style: string | null;
        level: number | null;
      }
    | {
        kind: "table";
        index: number;
        rows: Array<Array<{ sourceRef: string; text: string }>>;
      }
  >;
  sources: PlaybookSourceRef[];
  text: string;
};

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function attr(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return match ? decodeXml(match[1]) : null;
}

function tagValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}\\b([^>]*)/?>`, "i"));
  return match ? attr(match[1], "w:val") ?? attr(match[1], "val") : null;
}

function textFromParagraph(xml: string): string {
  const pieces: string[] = [];
  const token = /<w:(t|tab|br)\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^>]*\/>/gi;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml))) {
    const type = match[1] ?? match[3];
    if (type === "tab") pieces.push("\t");
    else if (type === "br") pieces.push("\n");
    else pieces.push(decodeXml(match[2] ?? ""));
  }
  return pieces.join("").replace(/[ \t]+\n/g, "\n").trim();
}

function styleNames(stylesXml: string): Map<string, string> {
  const styles = new Map<string, string>();
  const re = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stylesXml))) {
    const id = attr(match[1], "w:styleId");
    const nameTag = match[2].match(/<w:name\b([^>]*)\/>/i);
    const name = nameTag ? attr(nameTag[1], "w:val") : null;
    if (id) styles.set(id, name || id);
  }
  return styles;
}

function paragraphMetadata(
  xml: string,
  styles: Map<string, string>,
): { style: string | null; level: number | null } {
  const styleId = tagValue(xml, "w:pStyle");
  const style = styleId ? styles.get(styleId) ?? styleId : null;
  const outline = tagValue(xml, "w:outlineLvl");
  const headingMatch = (style ?? "").match(/heading\s*(\d+)/i);
  const level = outline !== null
    ? Number.parseInt(outline, 10) + 1
    : headingMatch
      ? Number.parseInt(headingMatch[1], 10)
      : null;
  return { style, level: Number.isFinite(level) ? level : null };
}

export async function extractPlaybookWordStructure(
  buffer: Buffer,
): Promise<PlaybookWordStructure> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) throw new Error("The Word file does not contain a document body.");
  const stylesXml = (await zip.file("word/styles.xml")?.async("text")) ?? "";
  const styles = styleNames(stylesXml);
  const body = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i)?.[1];
  if (!body) throw new Error("The Word document body could not be read.");

  const blocks: PlaybookWordStructure["blocks"] = [];
  const sources: PlaybookSourceRef[] = [];
  let paragraphIndex = 0;
  let tableIndex = 0;
  const blockRe = /<w:(p|tbl)\b[^>]*>[\s\S]*?<\/w:\1>/gi;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(body))) {
    const xml = blockMatch[0];
    if (blockMatch[1] === "p") {
      const text = textFromParagraph(xml);
      if (!text) continue;
      paragraphIndex += 1;
      const sourceRef = `P${paragraphIndex}`;
      const metadata = paragraphMetadata(xml, styles);
      sources.push({
        id: sourceRef,
        kind: "paragraph",
        text,
        style: metadata.style,
        level: metadata.level,
      });
      blocks.push({ kind: "paragraph", sourceRef, text, ...metadata });
      continue;
    }

    tableIndex += 1;
    const rows: Array<Array<{ sourceRef: string; text: string }>> = [];
    const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi;
    let rowMatch: RegExpExecArray | null;
    let rowIndex = 0;
    while ((rowMatch = rowRe.exec(xml))) {
      rowIndex += 1;
      const cells: Array<{ sourceRef: string; text: string }> = [];
      const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi;
      let cellMatch: RegExpExecArray | null;
      let columnIndex = 0;
      while ((cellMatch = cellRe.exec(rowMatch[1]))) {
        columnIndex += 1;
        const paragraphs = [...cellMatch[1].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi)]
          .map((item) => textFromParagraph(item[0]))
          .filter(Boolean);
        const text = paragraphs.join("\n").trim();
        const sourceRef = `T${tableIndex}R${rowIndex}C${columnIndex}`;
        cells.push({ sourceRef, text });
        if (text) {
          sources.push({
            id: sourceRef,
            kind: "table_cell",
            text,
            style: null,
            level: null,
            table: tableIndex,
            row: rowIndex,
            column: columnIndex,
          });
        }
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) blocks.push({ kind: "table", index: tableIndex, rows });
  }

  const text = blocks
    .map((block) => {
      if (block.kind === "paragraph") {
        const prefix = block.level ? `${"#".repeat(Math.min(6, block.level))} ` : "";
        return `[${block.sourceRef}] ${prefix}${block.text}`;
      }
      return block.rows
        .map((row) => row.map((cell) => `[${cell.sourceRef}] ${cell.text}`).join(" | "))
        .join("\n");
    })
    .join("\n\n")
    .trim();

  if (!text) throw new Error("The Word playbook does not contain readable text.");
  return { format: "docx", blocks, sources, text };
}

import { VISUAL_KIT_VERSION } from "./kit";

/** A document the visual was built from, recorded for the snapshot line. */
export type VisualSourceRef = {
  document_id: string;
  version_id: string | null;
  filename: string;
};

export type VisualSource = {
  title: string;
  kind: string;
  summary: string;
  html: string;
  kit: string;
  /** When this version was authored, ISO 8601. */
  createdAt: string;
  sources: VisualSourceRef[];
};

const escapeAttr = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The stored form: the authored fragment inside a minimal document that
 * carries the title, kind, summary, kit version, date and source list as
 * metadata. The kit itself is added when the document is served.
 */
export function serializeVisual(src: VisualSource): Buffer {
  const sources = escapeAttr(JSON.stringify(src.sources));
  return Buffer.from(
    `<!doctype html>\n<html lang="en" data-mike-visual="1" data-mike-kind="${escapeAttr(src.kind)}">` +
      `<head><meta charset="utf-8">` +
      `<meta name="mike-visual-kit" content="${escapeAttr(src.kit)}">` +
      `<meta name="mike-visual-created" content="${escapeAttr(src.createdAt)}">` +
      `<meta name="mike-visual-sources" content="${sources}">` +
      `<meta name="description" content="${escapeAttr(src.summary)}">` +
      `<title>${escapeText(src.title)}</title></head>\n<body>${src.html}</body></html>\n`,
    "utf8",
  );
}

export async function parseStoredVisual(bytes: Buffer | ArrayBuffer): Promise<VisualSource> {
  const text = Buffer.from(bytes as Buffer).toString("utf8");
  const { document } = (await import("linkedom")).parseHTML(text);
  const meta = (name: string) =>
    document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
  let sources: VisualSourceRef[] = [];
  try {
    const parsed: unknown = JSON.parse(meta("mike-visual-sources") || "[]");
    if (Array.isArray(parsed)) sources = parsed.filter(isSourceRef);
  } catch {
    sources = [];
  }
  return {
    title: document.querySelector("title")?.textContent?.trim() || "Visual",
    kind: document.documentElement?.getAttribute("data-mike-kind") || "other",
    summary: meta("description"),
    html: document.body?.innerHTML ?? "",
    kit: meta("mike-visual-kit") || VISUAL_KIT_VERSION,
    createdAt: meta("mike-visual-created"),
    sources,
  };
}

function isSourceRef(value: unknown): value is VisualSourceRef {
  const ref = value as VisualSourceRef | null;
  return (
    !!ref &&
    typeof ref.document_id === "string" &&
    typeof ref.filename === "string" &&
    (ref.version_id === null || typeof ref.version_id === "string")
  );
}

const DATA_BLOCK =
  /<script type="application\/json" id="mv-data-([a-z][a-z0-9_-]{0,31})">([\s\S]*?)<\/script>\n?/g;

/** The data blocks a stored page carries, apart from the page itself. */
export function splitDataBlocks(html: string): { html: string; blocks: Map<string, string> } {
  const blocks = new Map<string, string>();
  const rest = html.replace(DATA_BLOCK, (_match, name: string, json: string) => {
    blocks.set(name, json);
    return "";
  });
  return { html: rest.trim(), blocks };
}

const FULL_DOCUMENT = /<\s*(?:!doctype|html|head|body)\b/i;

/**
 * A model that sends a whole document instead of a fragment still gets its
 * work saved: the body becomes the fragment and any inline head styles and
 * scripts ride along.
 */
export async function normalizeFragment(html: string): Promise<{ html: string; normalized: boolean }> {
  if (!FULL_DOCUMENT.test(html)) return { html, normalized: false };
  const { document } = (await import("linkedom")).parseHTML(html);
  const head = [...document.querySelectorAll("head > style, head > script:not([src])")]
    .map((el) => el.outerHTML)
    .join("\n");
  const body = document.body?.innerHTML ?? "";
  return { html: [head, body].filter(Boolean).join("\n"), normalized: true };
}

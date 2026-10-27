// Citations inside a visual name documents by the chat's doc-N labels when
// the model writes them, and by document and version ids once stored, so a
// visual reopened in another turn still points at the right source.

export type CiteTarget = { document_id: string; version_id: string | null };

const ATTRIBUTE = /data-cite=(["'])([^"']+)\1(\s+data-cite-version=(["'])[^"']*\4)?/g;
// `cite: "doc-1"` in helper data; `citeVersion` and `data-cite` do not match.
const SCRIPT_KEY = /(?<![\w-])(["']?)cite\1\s*:\s*(["'])([^"']+)\2(\s*,\s*(["']?)citeVersion\5\s*:\s*(["'])[^"']*\6)?/g;

/**
 * Rewrites every citation label through `resolve`. Labels it cannot resolve
 * are left as written, so the lint can name them.
 */
export function resolveVisualCites(
  html: string,
  resolve: (label: string) => CiteTarget | "active" | null,
): { html: string; targets: CiteTarget[] } {
  const targets = new Map<string, CiteTarget>();
  const lookup = (label: string) => {
    const target = resolve(label);
    if (target && target !== "active") {
      targets.set(`${target.document_id}:${target.version_id ?? ""}`, target);
    }
    return target;
  };
  const rewritten = html
    .replace(ATTRIBUTE, (match, q, label) => {
      const target = lookup(label);
      if (!target) return match;
      if (target === "active") return `data-cite=${q}active${q}`;
      const version = target.version_id ? ` data-cite-version=${q}${target.version_id}${q}` : "";
      return `data-cite=${q}${target.document_id}${q}${version}`;
    })
    .replace(SCRIPT_KEY, (match, kq, q, label) => {
      const target = lookup(label);
      if (!target) return match;
      if (target === "active") return `${kq}cite${kq}: ${q}active${q}`;
      const version = target.version_id ? `, ${kq}citeVersion${kq}: ${q}${target.version_id}${q}` : "";
      return `${kq}cite${kq}: ${q}${target.document_id}${q}${version}`;
    });
  return { html: rewritten, targets: [...targets.values()] };
}

/** The inverse, for handing a stored visual back to the model as it wrote it. */
export function relabelVisualCites(html: string, labelFor: (documentId: string) => string | null): string {
  return html
    .replace(ATTRIBUTE, (match, q, id) => {
      const label = labelFor(id);
      return label ? `data-cite=${q}${label}${q}` : match;
    })
    .replace(SCRIPT_KEY, (match, kq, q, id) => {
      const label = labelFor(id);
      return label ? `${kq}cite${kq}: ${q}${label}${q}` : match;
    });
}

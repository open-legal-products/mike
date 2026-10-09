/** Parse the current JSON edit protocol from a streamed Word response. */

export type WordEditFormat =
  | "bold"
  | "italic"
  | "underline"
  | "heading1"
  | "heading2"
  | "heading3";

const WORD_EDIT_FORMATS: readonly WordEditFormat[] = [
  "bold",
  "italic",
  "underline",
  "heading1",
  "heading2",
  "heading3",
];

/** True for formats that apply a paragraph style rather than a font change. */
export function isParagraphStyleFormat(format: WordEditFormat): boolean {
  return format.startsWith("heading");
}

export interface RedlineEdit {
  original: string;
  replacement: string;
  format?: WordEditFormat[];
  occurrence?: "all";
  reason?: string;
}

export interface StreamingRedlineEdit {
  blockIndex: number;
  original: string;
  replacement?: string;
  format?: WordEditFormat[];
  occurrence?: "all";
  reason?: string;
  sealed: boolean;
}

export type RedlineStreamSegment =
  | { kind: "prose"; text: string }
  | { kind: "edit"; edit: StreamingRedlineEdit };

interface RedlineStreamProjection {
  visibleProse: string;
  edits: StreamingRedlineEdit[];
  safeEdits: RedlineEdit[];
  blockCount: number;
  segments: RedlineStreamSegment[];
  protocolStarted: boolean;
}

const JSON_EDITS_OPEN = "<edits>";
const JSON_EDITS_CLOSE = "</edits>";

function normalizeVisibleProse(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function partialTagStartAtEnd(text: string, tag: string): number {
  const lower = text.toLowerCase();
  for (let length = tag.length - 1; length >= 1; length -= 1) {
    if (lower.endsWith(tag.slice(0, length))) return text.length - length;
  }
  return -1;
}

function parseJsonStreamingEdit(
  value: string,
  blockIndex: number,
): StreamingRedlineEdit | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    // A half-streamed object, not a fault: the next chunk completes it.
    return null;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const row = candidate as Record<string, unknown>;
  if (row.type !== "edit_data" || row.kind !== "edit") return null;
  const original = typeof row.deleted_text === "string" ? row.deleted_text : "";
  if (!original.trim() || original.length > 200) return null;

  const hasReplacement = Object.prototype.hasOwnProperty.call(
    row,
    "inserted_text",
  );
  const hasFormats = Object.prototype.hasOwnProperty.call(row, "formats");
  if (hasReplacement === hasFormats) return null;

  let replacement: string | undefined;
  let format: WordEditFormat[] | undefined;
  if (hasReplacement) {
    if (typeof row.inserted_text !== "string") return null;
    replacement = row.inserted_text;
  } else {
    if (!Array.isArray(row.formats) || row.formats.length === 0) return null;
    if (
      row.formats.some(
        (entry) =>
          typeof entry !== "string" ||
          !WORD_EDIT_FORMATS.includes(entry as WordEditFormat),
      )
    ) {
      return null;
    }
    format = [...new Set(row.formats as WordEditFormat[])];
  }
  if (
    row.occurrence !== undefined &&
    row.occurrence !== null &&
    row.occurrence !== "all"
  ) {
    return null;
  }
  return {
    blockIndex,
    original,
    ...(replacement !== undefined ? { replacement } : {}),
    ...(format ? { format } : {}),
    ...(row.occurrence === "all" ? { occurrence: "all" as const } : {}),
    ...(typeof row.reason === "string" && row.reason.trim()
      ? { reason: row.reason.trim() }
      : {}),
    sealed: true,
  };
}

/** Only expose objects after a delimiter proves they are valid array items. */
function completedJsonObjects(value: string): {
  objects: string[];
  hasIncompleteObject: boolean;
} {
  const arrayStart = value.indexOf("[");
  if (arrayStart < 0) return { objects: [], hasIncompleteObject: false };
  const objects: string[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectStart = -1;
  let hasUnsealedObject = false;
  for (let index = arrayStart + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        let delimiterIndex = index + 1;
        while (/\s/.test(value[delimiterIndex] ?? "")) delimiterIndex += 1;
        const delimiter = value[delimiterIndex];
        if (delimiter === "," || delimiter === "]") {
          objects.push(value.slice(objectStart, index + 1));
        } else {
          hasUnsealedObject = true;
        }
        objectStart = -1;
      }
    }
  }
  return { objects, hasIncompleteObject: depth > 0 || hasUnsealedObject };
}

function hasJsonEditsProtocol(text: string): boolean {
  if (/<EDITS>/i.test(text)) return true;
  return partialTagStartAtEnd(text, JSON_EDITS_OPEN) >= 0;
}

function projectPlainStream(text: string): RedlineStreamProjection {
  const visibleProse = normalizeVisibleProse(text);
  return {
    visibleProse,
    edits: [],
    safeEdits: [],
    blockCount: 0,
    segments: visibleProse ? [{ kind: "prose", text: visibleProse }] : [],
    protocolStarted: false,
  };
}

function projectJsonEditsStream(text: string): RedlineStreamProjection {
  const lower = text.toLowerCase();
  const openIndex = lower.indexOf(JSON_EDITS_OPEN);
  if (openIndex < 0) {
    const partialStart = partialTagStartAtEnd(text, JSON_EDITS_OPEN);
    const prose = partialStart >= 0 ? text.slice(0, partialStart) : text;
    const visibleProse = normalizeVisibleProse(prose);
    return {
      visibleProse,
      edits: [],
      safeEdits: [],
      blockCount: 0,
      segments: visibleProse ? [{ kind: "prose", text: visibleProse }] : [],
      protocolStarted: true,
    };
  }

  const valueStart = openIndex + JSON_EDITS_OPEN.length;
  const closeIndex = lower.indexOf(JSON_EDITS_CLOSE, valueStart);
  const jsonSource = text.slice(
    valueStart,
    closeIndex >= 0 ? closeIndex : undefined,
  );
  const prefix = normalizeVisibleProse(text.slice(0, openIndex));
  const suffix =
    closeIndex >= 0
      ? normalizeVisibleProse(text.slice(closeIndex + JSON_EDITS_CLOSE.length))
      : "";
  const scanned = completedJsonObjects(jsonSource);
  let objectValues: unknown[] = scanned.objects;
  if (closeIndex >= 0) {
    try {
      const parsed = JSON.parse(jsonSource);
      if (Array.isArray(parsed)) objectValues = parsed;
    } catch {
      // Valid delimited objects already streamed remain actionable.
    }
  }

  const edits: StreamingRedlineEdit[] = [];
  const safeEdits: RedlineEdit[] = [];
  const seenSafeOriginals = new Set<string>();
  for (const [blockIndex, value] of objectValues.entries()) {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const edit = parseJsonStreamingEdit(raw, blockIndex);
    if (!edit) {
      edits.push({ blockIndex, original: "", sealed: false });
      continue;
    }
    if (seenSafeOriginals.has(edit.original)) continue;
    seenSafeOriginals.add(edit.original);
    edits.push(edit);
    safeEdits.push({
      original: edit.original,
      replacement: edit.replacement ?? "",
      ...(edit.format ? { format: edit.format } : {}),
      ...(edit.occurrence ? { occurrence: edit.occurrence } : {}),
      ...(edit.reason ? { reason: edit.reason } : {}),
    });
  }

  const segments: RedlineStreamSegment[] = [];
  if (prefix) segments.push({ kind: "prose", text: prefix });
  segments.push(...edits.map((edit) => ({ kind: "edit" as const, edit })));
  const blockCount =
    objectValues.length +
    (closeIndex < 0 && scanned.hasIncompleteObject ? 1 : 0);
  if (closeIndex < 0 && scanned.hasIncompleteObject) {
    const provisional: StreamingRedlineEdit = {
      blockIndex: objectValues.length,
      original: "",
      sealed: false,
    };
    edits.push(provisional);
    segments.push({ kind: "edit", edit: provisional });
  }
  if (suffix) segments.push({ kind: "prose", text: suffix });

  return {
    visibleProse: normalizeVisibleProse(
      [prefix, suffix].filter(Boolean).join("\n\n"),
    ),
    edits,
    safeEdits,
    blockCount,
    segments,
    protocolStarted: true,
  };
}

let lastProjectionText: string | null = null;
let lastProjection: RedlineStreamProjection | null = null;

export function projectRedlineStream(text: string): RedlineStreamProjection {
  if (lastProjection && lastProjectionText === text) return lastProjection;
  const projection = hasJsonEditsProtocol(text)
    ? projectJsonEditsStream(text)
    : projectPlainStream(text);
  lastProjectionText = text;
  lastProjection = projection;
  return projection;
}

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

export interface RedlineStreamProjection {
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
  const lower = text.slice(-(tag.length - 1)).toLowerCase();
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

/**
 * Append-only parser owned by one streamed response. A partially received JSON
 * string is scanned once; sealed objects are parsed once. Snapshots remain
 * immutable so React can retain completed edit cards.
 */
export function createRedlineStreamProjector() {
  let text = "";
  let open = -1;
  let cursor = 0;
  let arrayStarted = false, inString = false, escaped = false;
  let depth = 0, objectStart = -1, objectEnd = -1;
  let invalidUnsealed = false, closed = false, rawCount = 0;
  let prefix = "";
  let suffixStart = -1;
  let closedSegments: RedlineStreamSegment[] = [];
  const edits: StreamingRedlineEdit[] = [];
  const safeEdits: RedlineEdit[] = [];
  const originals = new Set<string>();
  let projection = projectPlainStream("");
  let scannedCharacters = 0;

  function snapshot(incomplete: boolean): RedlineStreamProjection {
    const visibleEdits = [...edits];
    if (incomplete) visibleEdits.push({ blockIndex: rawCount, original: "", sealed: false });
    return {
      visibleProse: prefix, edits: visibleEdits, safeEdits: [...safeEdits],
      blockCount: rawCount + (incomplete ? 1 : 0), protocolStarted: true,
      segments: [
        ...(prefix ? [{ kind: "prose" as const, text: prefix }] : []),
        ...visibleEdits.map(edit => ({ kind: "edit" as const, edit })),
      ],
    };
  }
  return {
    get projection() { return projection; },
    get scannedCharacters() { return scannedCharacters; },
    append(delta: string): RedlineStreamProjection {
      const previousLength = text.length;
      text += delta;
      if (closed) {
        const suffix = normalizeVisibleProse(text.slice(suffixStart));
        return projection = { ...projection,
          visibleProse: normalizeVisibleProse([prefix, suffix].filter(Boolean).join("\n\n")),
          segments: [...closedSegments, ...(suffix ? [{ kind: "prose" as const, text: suffix }] : [])],
        };
      }
      if (open < 0) {
        const start = Math.max(0, previousLength - JSON_EDITS_OPEN.length + 1);
        const found = text.slice(start).toLowerCase().indexOf(JSON_EDITS_OPEN);
        if (found < 0) return projection = partialTagStartAtEnd(text, JSON_EDITS_OPEN) >= 0
          ? projectJsonEditsStream(text) : projectPlainStream(text);
        open = start + found;
        prefix = normalizeVisibleProse(text.slice(0, open));
        cursor = open + JSON_EDITS_OPEN.length;
      }
      const closeStart = Math.max(open + JSON_EDITS_OPEN.length, previousLength - JSON_EDITS_CLOSE.length + 1);
      const closeOffset = text.slice(closeStart).toLowerCase().indexOf(JSON_EDITS_CLOSE);
      if (closeOffset >= 0) {
        closed = true;
        suffixStart = closeStart + closeOffset + JSON_EDITS_CLOSE.length;
        // One final parse preserves validation of the entire array, including
        // malformed/non-object entries that the streaming scanner won't seal.
        projection = projectJsonEditsStream(text);
        const hasSuffix = !!normalizeVisibleProse(text.slice(suffixStart));
        closedSegments = hasSuffix ? projection.segments.slice(0, -1) : projection.segments;
        return projection;
      }
      const previousCount = rawCount;
      const wasIncomplete = depth > 0 || objectEnd >= 0 || invalidUnsealed;
      for (; cursor < text.length; cursor++) {
        scannedCharacters++;
        const character = text[cursor]!;
        if (!arrayStarted) { if (character === "[") arrayStarted = true; continue; }
        if (objectEnd >= 0 && !/\s/.test(character)) {
          if (character === "," || character === "]") {
            const edit = parseJsonStreamingEdit(text.slice(objectStart, objectEnd + 1), rawCount++);
            if (!edit) edits.push({ blockIndex: rawCount - 1, original: "", sealed: false });
            else if (!originals.has(edit.original)) {
              originals.add(edit.original); edits.push(edit);
              safeEdits.push({ original: edit.original, replacement: edit.replacement ?? "", ...(edit.format ? { format: edit.format } : {}), ...(edit.occurrence ? { occurrence: edit.occurrence } : {}), ...(edit.reason ? { reason: edit.reason } : {}) });
            }
          } else invalidUnsealed = true;
          objectStart = -1; objectEnd = -1;
        }
        if (escaped) { escaped = false; continue; }
        if (character === "\\" && inString) { escaped = true; continue; }
        if (character === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (character === "{") { if (depth === 0) objectStart = cursor; depth++; }
        else if (character === "}" && depth > 0) { depth--; if (depth === 0 && objectStart >= 0) objectEnd = cursor; }
      }
      const incomplete = depth > 0 || objectEnd >= 0 || invalidUnsealed;
      if (projection.protocolStarted && previousCount === rawCount && wasIncomplete === incomplete) return projection;
      return projection = snapshot(incomplete);
    },
  };
}

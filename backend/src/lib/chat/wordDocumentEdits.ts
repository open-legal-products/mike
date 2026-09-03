import type { Db } from "../supabase";

export type WordEditApplyMode = "direct" | "approval";

interface ParsedWordDocumentEdit {
  blockIndex: number;
  originalText: string;
  replacementText: string;
  formats: string[];
  occurrence: "all" | null;
  reason: string | null;
}

interface ContentPart {
  kind: "content" | "edit";
  text?: string;
  blockIndex?: number;
  sourceEvent: Record<string, unknown>;
}

const COMPLETE_JSON_EDITS = /<EDITS>\s*([\s\S]*?)\s*<\/EDITS>/gi;

export const WORD_EDIT_FORMATS: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "underline",
  "heading1",
  "heading2",
  "heading3",
]);

function cleanProse(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function parseJsonEdit(
  value: unknown,
  blockIndex: number,
): ParsedWordDocumentEdit | null {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const row = candidate as Record<string, unknown>;
  if (row.type !== "edit_data" || row.kind !== "edit") return null;
  const originalText =
    typeof row.deleted_text === "string" ? row.deleted_text : "";
  if (!originalText.trim() || originalText.length > 200) return null;

  const hasReplacement = Object.prototype.hasOwnProperty.call(
    row,
    "inserted_text",
  );
  const hasFormats = Object.prototype.hasOwnProperty.call(row, "formats");
  if (hasReplacement === hasFormats) return null;

  let replacementText = "";
  let formats: string[] = [];
  if (hasReplacement) {
    if (typeof row.inserted_text !== "string") return null;
    replacementText = row.inserted_text;
  } else {
    if (!Array.isArray(row.formats) || row.formats.length === 0) return null;
    if (
      row.formats.some(
        (format) =>
          typeof format !== "string" || !WORD_EDIT_FORMATS.has(format),
      )
    ) {
      return null;
    }
    formats = [...new Set(row.formats as string[])];
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
    originalText,
    replacementText,
    formats,
    occurrence: row.occurrence === "all" ? "all" : null,
    reason:
      typeof row.reason === "string" && row.reason.trim()
        ? row.reason.trim()
        : null,
  };
}

/**
 * Read one `word_edit_block` placement marker — the tool channel's answer to
 * a parsed `<EDITS>` row. The backend adapter already validated the model's
 * input, so this only re-checks what the DB column demands.
 */
function parseToolEditBlock(
  event: Record<string, unknown>,
): ParsedWordDocumentEdit | null {
  const blockIndex = event.block_index;
  if (
    typeof blockIndex !== "number" ||
    !Number.isSafeInteger(blockIndex) ||
    blockIndex < 0
  ) {
    return null;
  }
  const originalText =
    typeof event.original_text === "string" ? event.original_text : "";
  if (!originalText.trim() || originalText.length > 200) return null;
  const replacementText =
    typeof event.replacement_text === "string" ? event.replacement_text : "";
  const formats = Array.isArray(event.formats)
    ? event.formats.filter(
        (format): format is string =>
          typeof format === "string" && WORD_EDIT_FORMATS.has(format),
      )
    : [];
  return {
    blockIndex,
    originalText,
    replacementText,
    formats: [...new Set(formats)],
    occurrence: event.occurrence === "all" ? "all" : null,
    reason:
      typeof event.reason === "string" && event.reason.trim()
        ? event.reason.trim()
        : null,
  };
}

/**
 * Split completed Word edit protocol out of assistant content while retaining
 * the exact event position at which every edit appeared.
 *
 * Two channels feed this: `<EDITS>` blocks embedded in content text, and
 * `word_edit_block` events the client-tool adapter splices in where a tool
 * call landed. Both leave the same `{kind:"edit"}` part behind, so the
 * normalized history a chat replays is identical whichever channel produced
 * it.
 */
export function projectWordDocumentEditEvents(events: unknown[]): {
  parts: ContentPart[];
  edits: ParsedWordDocumentEdit[];
} {
  const parts: ContentPart[] = [];
  const edits: ParsedWordDocumentEdit[] = [];
  const seenOriginals = new Set<string>();
  const seenBlockIndexes = new Set<number>();
  let blockIndex = 0;

  for (const candidate of events) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const event = candidate as Record<string, unknown>;
    if (event.type === "word_edit_block") {
      const parsed = parseToolEditBlock(event);
      // A duplicate ordinal would upsert two different edits onto one row;
      // drop the later marker rather than let the card lie.
      if (parsed && !seenBlockIndexes.has(parsed.blockIndex)) {
        seenBlockIndexes.add(parsed.blockIndex);
        edits.push(parsed);
        parts.push({
          kind: "edit",
          blockIndex: parsed.blockIndex,
          sourceEvent: event,
        });
      }
      continue;
    }
    if (event.type !== "content" || typeof event.text !== "string") {
      parts.push({ kind: "content", sourceEvent: event });
      continue;
    }

    const text = event.text;
    const matcher = new RegExp(COMPLETE_JSON_EDITS.source, "gi");
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      const prose = cleanProse(text.slice(cursor, match.index));
      if (prose) {
        parts.push({ kind: "content", text: prose, sourceEvent: event });
      }
      let rows: unknown = null;
      try {
        rows = JSON.parse(match[1] ?? "");
      } catch {
        rows = null;
      }
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const parsed = parseJsonEdit(row, blockIndex);
          if (
            parsed &&
            !seenOriginals.has(parsed.originalText) &&
            !seenBlockIndexes.has(blockIndex)
          ) {
            seenOriginals.add(parsed.originalText);
            seenBlockIndexes.add(blockIndex);
            edits.push(parsed);
            parts.push({ kind: "edit", blockIndex, sourceEvent: event });
          }
          blockIndex += 1;
        }
      }
      cursor = matcher.lastIndex;
    }

    const tail = cleanProse(text.slice(cursor));
    if (tail) parts.push({ kind: "content", text: tail, sourceEvent: event });
  }

  return { parts, edits };
}

export async function persistWordDocumentEdits(args: {
  db: Db;
  messageId: string;
  events: unknown[];
  applyMode: WordEditApplyMode;
}): Promise<{
  events: Record<string, unknown>[];
  edits: Record<string, unknown>[];
}> {
  const projection = projectWordDocumentEditEvents(args.events);
  if (projection.edits.length === 0) {
    return {
      events: args.events.filter(
        (event): event is Record<string, unknown> =>
          !!event && typeof event === "object" && !Array.isArray(event),
      ),
      edits: [],
    };
  }

  const rows = projection.edits.map((edit) => ({
    word_chat_message_id: args.messageId,
    block_index: edit.blockIndex,
    original_text: edit.originalText,
    replacement_text: edit.replacementText,
    formats: edit.formats,
    occurrence: edit.occurrence,
    reason: edit.reason,
    apply_mode: args.applyMode,
  }));
  const { error: insertError } = await args.db
    .from("word_document_edits")
    .upsert(rows, {
      onConflict: "word_chat_message_id,block_index",
      ignoreDuplicates: true,
    })
    .select("id");
  if (insertError) {
    throw new Error(insertError.message);
  }
  const { data, error } = await args.db
    .from("word_document_edits")
    .select("*")
    .eq("word_chat_message_id", args.messageId)
    .in(
      "block_index",
      projection.edits.map((edit) => edit.blockIndex),
    );
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to load persisted Word edits");
  }

  const editByIndex = new Map(
    (data as Record<string, unknown>[]).map((row) => [
      Number(row.block_index),
      row,
    ]),
  );
  if (editByIndex.size !== projection.edits.length) {
    throw new Error("One or more Word edits could not be persisted");
  }
  const normalizedEvents: Record<string, unknown>[] = [];
  for (const part of projection.parts) {
    if (part.kind === "edit") {
      const edit = editByIndex.get(part.blockIndex as number);
      if (typeof edit?.id === "string") {
        normalizedEvents.push({
          type: "word_edit_ref",
          edit_id: edit.id,
        });
      }
      continue;
    }
    if (part.text !== undefined) {
      normalizedEvents.push({
        ...part.sourceEvent,
        type: "content",
        text: part.text,
      });
    } else {
      normalizedEvents.push(part.sourceEvent);
    }
  }
  return {
    events: normalizedEvents,
    edits: data as Record<string, unknown>[],
  };
}

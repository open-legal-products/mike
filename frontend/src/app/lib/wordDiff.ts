export type DiffSegment = {
  type: "equal" | "removed" | "added";
  text: string;
};

// Above this many token comparisons the table would be slow to build; such a
// pair is shown as a whole replacement instead of a word-level diff.
const MAX_CELLS = 400_000;

/** Words and the whitespace between them, so joining tokens restores text. */
function tokenize(text: string) {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

function push(segments: DiffSegment[], type: DiffSegment["type"], text: string) {
  const last = segments[segments.length - 1];
  if (last?.type === type) last.text += text;
  else segments.push({ type, text });
}

/**
 * A word-level diff of `before` into `after`, by longest common subsequence.
 * Joining the equal and removed segments gives `before`; joining the equal and
 * added segments gives `after`.
 */
export function diffWords(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (!a.length && !b.length) return [];
  if (a.length * b.length > MAX_CELLS) {
    const whole: DiffSegment[] = [];
    if (before) whole.push({ type: "removed", text: before });
    if (after) whole.push({ type: "added", text: after });
    return whole;
  }

  // lengths[i][j]: the common subsequence length of a[i..] and b[j..].
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(segments, "equal", a[i]);
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      push(segments, "removed", a[i]);
      i += 1;
    } else {
      push(segments, "added", b[j]);
      j += 1;
    }
  }
  for (; i < a.length; i += 1) push(segments, "removed", a[i]);
  for (; j < b.length; j += 1) push(segments, "added", b[j]);
  return joinChanges(segments);
}

/**
 * Reads as phrases rather than alternating words: whitespace between two
 * changes joins them, and each run of changes becomes one removal followed by
 * one addition.
 */
function joinChanges(segments: DiffSegment[]): DiffSegment[] {
  const joined: DiffSegment[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed) push(joined, "removed", removed);
    if (added) push(joined, "added", added);
    removed = "";
    added = "";
  };
  segments.forEach((segment, index) => {
    if (segment.type === "removed") removed += segment.text;
    else if (segment.type === "added") added += segment.text;
    else if (
      (removed || added) &&
      !segment.text.trim() &&
      segments[index + 1] &&
      segments[index + 1].type !== "equal"
    ) {
      removed += segment.text;
      added += segment.text;
    } else {
      flush();
      push(joined, "equal", segment.text);
    }
  });
  flush();
  return joined;
}

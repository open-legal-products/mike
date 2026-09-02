/**
 * Quoted excerpts — the wire and persistence format for "Add to Chat".
 *
 * When a user highlights part of an assistant response and attaches it to the
 * composer, the excerpt has to survive three trips: to the model on this turn,
 * into the persisted chat history, and back out again when the chat is
 * reloaded and re-rendered.
 *
 * Rather than add a structured `quoted_excerpts` field to the request body
 * (which would need a backend change, a schema migration for the messages
 * table, and a history-replay path that knows how to fold it back into the
 * prompt), the excerpts are encoded *into* the user message content as
 * ordinary markdown blockquotes under a short preface line:
 *
 *     Referring to this part of your earlier response:
 *
 *     > the highlighted text
 *     > second line of the same excerpt
 *
 *     > a second, separate excerpt
 *
 *     ...and then whatever the user actually typed.
 *
 * The persisted user message is therefore self-contained: history replay,
 * chat export, and every existing backend path keep working untouched, and a
 * model reading raw markdown sees a clearly delimited quote. The cost is that
 * the excerpts are not machine-distinguishable from prose the user typed
 * themselves — `parseQuotedMessageContent` recovers them heuristically so the
 * UI can render them as quote blocks instead of raw `>` characters.
 *
 * Excerpt encoding rules, chosen so the round trip is lossless:
 * - every line of an excerpt is prefixed, blank lines included ("&gt;" alone),
 *   so a blank line unambiguously separates one excerpt from the next;
 * - excerpts are separated by exactly one blank line;
 * - the body is separated from the last excerpt by exactly one blank line, and
 *   is taken verbatim from the first line that is neither blank nor a
 *   blockquote line.
 */

/** Leading line that marks a message as carrying quoted excerpts. */
export const QUOTED_EXCERPT_PREFACE =
    "Referring to this part of your earlier response:";

/**
 * Longest excerpt we will attach. Long enough for several paragraphs of a
 * response, short enough that a runaway "select all" cannot silently blow out
 * the prompt (or the message row) behind the user's back.
 */
export const MAX_QUOTED_EXCERPT_CHARS = 4000;

/** Collapse a DOM-derived selection into a single tidy run of text. */
export function normalizeExcerpt(raw: string): string {
    return raw.replace(/\s+/g, " ").trim();
}

/**
 * Enforce {@link MAX_QUOTED_EXCERPT_CHARS}, cutting back to a word boundary
 * where one is available so the excerpt does not end mid-word. Callers surface
 * `truncated` to the user rather than shortening the quote silently.
 */
export function capExcerpt(text: string): {
    text: string;
    truncated: boolean;
} {
    if (text.length <= MAX_QUOTED_EXCERPT_CHARS) {
        return { text, truncated: false };
    }
    const hard = text.slice(0, MAX_QUOTED_EXCERPT_CHARS);
    const lastSpace = hard.lastIndexOf(" ");
    // Only prefer the word boundary when it is not throwing away most of the
    // cap (a 4000-character run with no spaces should still be kept).
    const cut =
        lastSpace > MAX_QUOTED_EXCERPT_CHARS * 0.8
            ? hard.slice(0, lastSpace)
            : hard;
    return { text: `${cut.trimEnd()}…`, truncated: true };
}

/** Normalize, then cap, in the one step a caller attaching a chip needs. */
export function prepareExcerpt(raw: string): {
    text: string;
    truncated: boolean;
} {
    return capExcerpt(normalizeExcerpt(raw));
}

function encodeExcerpt(excerpt: string): string {
    return excerpt
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
}

function decodeExcerptLine(line: string): string {
    // "> text" -> "text", ">" -> "". A quote marker with no following space is
    // still a quote line; only the single space after ">" is markdown syntax.
    return line.startsWith("> ") ? line.slice(2) : line.slice(1);
}

const isQuoteLine = (line: string) => line.startsWith(">");

/**
 * Build the outgoing user message content. With no excerpts this is exactly
 * the text the user typed, so an untouched composer produces an untouched
 * message.
 */
export function buildQuotedMessageContent(
    excerpts: readonly string[],
    body: string,
): string {
    const usable = excerpts.filter((excerpt) => excerpt.trim().length > 0);
    if (usable.length === 0) return body;
    const blocks = usable.map(encodeExcerpt).join("\n\n");
    const trimmedBody = body.trim();
    const preamble = `${QUOTED_EXCERPT_PREFACE}\n\n${blocks}`;
    return trimmedBody.length > 0 ? `${preamble}\n\n${trimmedBody}` : preamble;
}

/**
 * Recover the excerpts and the user's own text from a persisted message.
 *
 * Returns `excerpts: []` and the original string as `body` for any message
 * that does not open with the preface line, so ordinary messages — and
 * messages written before this feature existed — render exactly as before.
 */
export function parseQuotedMessageContent(content: string): {
    excerpts: string[];
    body: string;
} {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== QUOTED_EXCERPT_PREFACE) {
        return { excerpts: [], body: content };
    }

    let index = 1;
    // Skip the blank line(s) between the preface and the first blockquote.
    while (index < lines.length && lines[index].trim() === "") index += 1;

    const excerpts: string[] = [];
    let current: string[] | null = null;
    for (; index < lines.length; index += 1) {
        const line = lines[index];
        if (isQuoteLine(line)) {
            if (!current) current = [];
            current.push(decodeExcerptLine(line));
            continue;
        }
        if (line.trim() === "") {
            if (current) {
                excerpts.push(current.join("\n"));
                current = null;
            }
            continue;
        }
        break;
    }
    if (current) excerpts.push(current.join("\n"));

    if (excerpts.length === 0) {
        // The preface line was the user's own prose, not our marker.
        return { excerpts: [], body: content };
    }

    return { excerpts, body: lines.slice(index).join("\n").trim() };
}

/** True when `content` carries at least one attached excerpt. */
export function hasQuotedExcerpts(content: string): boolean {
    return parseQuotedMessageContent(content).excerpts.length > 0;
}

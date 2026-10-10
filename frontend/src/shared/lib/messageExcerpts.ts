/**
 * Passages a reader highlighted in an assistant response and attached to
 * their next message, each with an optional note about it.
 *
 * They travel inside the message text as leading Markdown blockquotes, so the
 * model reads an ordinary quoted passage and no wire or storage shape changes:
 *
 *     > the highlighted passage
 *     Note: what the reader said about it
 *
 *     the rest of the message
 *
 * A passage asked about in another chat can bring the response it came from
 * along as context. That chat has never seen the response, so it follows the
 * message in a `<source_response>` block: the model reads it, on this turn
 * and in the history of later ones, while the reader's own message shows
 * only the passage.
 */
export type MessageExcerpt = {
    text: string;
    note?: string;
    /** The response the passage was taken from, sent as hidden context. */
    context?: string;
};

/** Long enough for several paragraphs, short enough to stay a quotation. */
export const MAX_EXCERPT_LENGTH = 4000;

/** A long answer in full; beyond this the context is cut, not the passage. */
export const MAX_EXCERPT_CONTEXT_LENGTH = 20000;

const NOTE_PREFIX = "Note: ";
const CONTEXT_OPEN = "<source_response>";
const CONTEXT_CLOSE = "</source_response>";
const CONTEXT_INTRO =
    "The quoted passage above was taken from this earlier assistant response, included for context:";
const TRAILING_CONTEXT = new RegExp(
    `\\n*(?:${CONTEXT_INTRO}\\n)?${CONTEXT_OPEN}\\n[\\s\\S]*?\\n${CONTEXT_CLOSE}\\s*$`,
);

/** A source response as context: normalized, and cut to a bounded length. */
export function normalizeExcerptContext(text: string): string {
    const normalized = text
        .replace(/\r\n?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        // The block's own closing tag must not end it early.
        .split(CONTEXT_CLOSE)
        .join("")
        .trim();
    return normalized.length > MAX_EXCERPT_CONTEXT_LENGTH
        ? `${normalized.slice(0, MAX_EXCERPT_CONTEXT_LENGTH).trimEnd()}…`
        : normalized;
}

function serializeContext(context: string): string {
    return `${CONTEXT_INTRO}\n${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}`;
}

/** `content` without the source-response blocks that follow the message. */
function stripContext(content: string): string {
    let stripped = content;
    while (TRAILING_CONTEXT.test(stripped)) {
        stripped = stripped.replace(TRAILING_CONTEXT, "");
    }
    return stripped;
}

/** Selected text as an excerpt: trimmed, with runs of blank lines collapsed. */
export function normalizeExcerptText(text: string): string {
    const normalized = text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return normalized.length > MAX_EXCERPT_LENGTH
        ? `${normalized.slice(0, MAX_EXCERPT_LENGTH).trimEnd()}…`
        : normalized;
}

/** A note is one line: it has to survive as a single `Note:` line. */
export function normalizeExcerptNote(note: string): string {
    return note.replace(/\s+/g, " ").trim();
}

function serializeExcerpt(excerpt: MessageExcerpt): string {
    const quoted = excerpt.text
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    return excerpt.note ? `${quoted}\n${NOTE_PREFIX}${excerpt.note}` : quoted;
}

/** The message text to send for `body` with `excerpts` quoted above it. */
export function serializeExcerpts(
    excerpts: readonly MessageExcerpt[],
    body: string,
): string {
    // One block per distinct response, however many passages came from it.
    const contexts = Array.from(
        new Set(
            excerpts.flatMap((excerpt) =>
                excerpt.context ? [excerpt.context] : [],
            ),
        ),
    );
    return [
        ...excerpts.map(serializeExcerpt),
        body,
        ...contexts.map(serializeContext),
    ]
        .filter((part) => part.length > 0)
        .join("\n\n");
}

/**
 * Splits a message into its leading quoted excerpts and the text after them.
 * A message that does not start with a blockquote comes back unchanged.
 * Source-response context is for the model, and is left out of both.
 */
export function parseExcerpts(rawContent: string): {
    excerpts: MessageExcerpt[];
    body: string;
} {
    const content = stripContext(rawContent);
    const lines = content.split("\n");
    const excerpts: MessageExcerpt[] = [];
    let index = 0;
    let bodyStart = 0;

    const isBlank = (line: string | undefined): boolean =>
        line === undefined || line.trim() === "";

    while (index < lines.length) {
        const quoted: string[] = [];
        for (
            let line = lines[index];
            line !== undefined && line.startsWith(">");
            line = lines[++index]
        ) {
            quoted.push(line.replace(/^> ?/, ""));
        }
        if (quoted.length === 0) break;

        let note: string | undefined;
        const noteLine = lines[index];
        if (noteLine !== undefined && noteLine.startsWith(NOTE_PREFIX)) {
            note = noteLine.slice(NOTE_PREFIX.length).trim();
            index++;
        }
        // An excerpt ends at a blank line or the end of the message; quoted
        // lines running straight into prose are the writer's own Markdown.
        if (!isBlank(lines[index])) break;

        excerpts.push({ text: quoted.join("\n"), ...(note ? { note } : {}) });
        while (index < lines.length && isBlank(lines[index])) index++;
        bodyStart = index;
    }

    if (excerpts.length === 0) return { excerpts, body: content };
    return { excerpts, body: lines.slice(bodyStart).join("\n") };
}

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
 */
export type MessageExcerpt = {
    text: string;
    note?: string;
};

/** Long enough for several paragraphs, short enough to stay a quotation. */
export const MAX_EXCERPT_LENGTH = 4000;

const NOTE_PREFIX = "Note: ";

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
    return [...excerpts.map(serializeExcerpt), body]
        .filter((part) => part.length > 0)
        .join("\n\n");
}

/**
 * Splits a message into its leading quoted excerpts and the text after them.
 * A message that does not start with a blockquote comes back unchanged.
 */
export function parseExcerpts(content: string): {
    excerpts: MessageExcerpt[];
    body: string;
} {
    const lines = content.split("\n");
    const excerpts: MessageExcerpt[] = [];
    let index = 0;
    let bodyStart = 0;

    while (index < lines.length) {
        const quoted: string[] = [];
        while (index < lines.length && lines[index].startsWith(">")) {
            quoted.push(lines[index].replace(/^> ?/, ""));
            index++;
        }
        if (quoted.length === 0) break;

        let note: string | undefined;
        if (index < lines.length && lines[index].startsWith(NOTE_PREFIX)) {
            note = lines[index].slice(NOTE_PREFIX.length).trim();
            index++;
        }
        // An excerpt ends at a blank line or the end of the message; quoted
        // lines running straight into prose are the writer's own Markdown.
        if (index < lines.length && lines[index].trim() !== "") break;

        excerpts.push({ text: quoted.join("\n"), ...(note ? { note } : {}) });
        while (index < lines.length && lines[index].trim() === "") index++;
        bodyStart = index;
    }

    if (excerpts.length === 0) return { excerpts, body: content };
    return { excerpts, body: lines.slice(bodyStart).join("\n") };
}

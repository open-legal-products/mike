import { useState } from "react";

// Ordinary responses keep their existing live formatting. Large blocks parse
// at geometric checkpoints; the unparsed suffix stays visible as plain text.
export const LIVE_MARKDOWN_LIMIT = 8192;
export function useMarkdownCheckpoint(text: string, streaming: boolean) {
    const [checkpoint, setCheckpoint] = useState(text);
    const publish = !streaming || text.length <= LIVE_MARKDOWN_LIMIT ||
        text.length >= Math.max(LIVE_MARKDOWN_LIMIT, checkpoint.length * 1.25) ||
        !text.startsWith(checkpoint);
    const richText = publish ? text : checkpoint;
    if (publish && checkpoint !== text) setCheckpoint(text);
    return { richText, plainTail: text.slice(richText.length) };
}

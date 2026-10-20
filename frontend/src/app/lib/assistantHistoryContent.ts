import type { AssistantEvent } from "@/app/components/shared/types";

/**
 * The text an assistant turn contributes to the history sent back to the
 * model.
 *
 * A turn streamed in this session keeps its prose in `events` and leaves
 * `content` empty; only a reloaded chat carries the joined text in `content`.
 * Providers differ on an empty assistant message: OpenAI accepts it, Anthropic
 * rejects the whole request ("text content blocks must be non-empty"), so the
 * history must carry the same text either way.
 */
export function assistantHistoryContent(message: {
  content: string;
  events?: AssistantEvent[];
}): string {
  // Cards are delivered outside prose. Include them in order even after a
  // reload, when `content` contains only the joined prose from this turn.
  if (message.events?.some((event) => event.type === "text_card")) {
    return message.events
      .flatMap((event) => {
        if (event.type === "content") return [event.text];
        if (event.type === "text_card") return [`${event.title}\n${event.text}`];
        return [];
      })
      .join("\n\n");
  }
  if (message.content) return message.content;
  return (message.events ?? [])
    .filter(
      (event): event is Extract<AssistantEvent, { type: "content" }> =>
        event.type === "content",
    )
    .map((event) => event.text)
    .join("");
}

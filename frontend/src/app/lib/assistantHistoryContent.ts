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
  if (message.content) return message.content;
  return (message.events ?? [])
    .filter(
      (event): event is Extract<AssistantEvent, { type: "content" }> =>
        event.type === "content",
    )
    .map((event) => event.text)
    .join("");
}

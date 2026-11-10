import type { TextCardEvent } from "@mike/contracts";

export const TEXT_CARD_TOOL = {
  type: "function",
  function: {
    name: "create_text_card",
    description:
      "Display copy-ready text in a read-only card inline at this point in the response. Use for drafted clauses, emails, letters, or other text the user will copy and paste. Supply only the intended text, preserving paragraphs and line breaks; put explanations and citations outside the card. This does not create a file or modify a document. Do not repeat the card's text in the surrounding response.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Short descriptive card title.",
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 100000,
          description:
            "Complete plain text to copy, without code fences or commentary.",
        },
      },
      required: ["title", "text"],
      additionalProperties: false,
    },
  },
};

export function textCardEvent(
  cardId: string,
  input: unknown,
): TextCardEvent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const args = input as Record<string, unknown>;
  if (
    typeof args.title !== "string" ||
    !args.title.trim() ||
    args.title.length > 200 ||
    typeof args.text !== "string" ||
    !args.text.trim() ||
    args.text.length > 100000
  )
    return null;
  return {
    type: "text_card",
    card_id: cardId,
    title: args.title.trim(),
    text: args.text,
  };
}

import type { AssistantEvent } from "@/app/components/shared/types";
import { assistantHistoryContent } from "@/app/lib/assistantHistoryContent";

type TabularHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  events?: AssistantEvent[];
};

export function buildTabularChatHistory(
  messages: TabularHistoryMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      message.role === "assistant"
        ? assistantHistoryContent(message)
        : message.content,
  }));
}

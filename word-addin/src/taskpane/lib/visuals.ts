import { isVisualFilename, visualTitle } from "@mike/visual-bridge";
import type { WordAssistantEvent } from "../types";
import { isWordDocumentWriteEvent } from "./wordChatEvents";

export { isVisualFilename, visualTitle };

export interface WordVisualRef {
  documentId: string;
  versionId?: string;
  versionNumber?: number | null;
  title: string;
}

export function latestVisualInTurn(
  events: WordAssistantEvent[],
): WordVisualRef | null {
  let latest: WordVisualRef | null = null;
  for (const event of events) {
    if (!isWordDocumentWriteEvent(event)) continue;
    if (event.isStreaming || event.error || !event.documentId) continue;
    if (!isVisualFilename(event.filename)) continue;
    latest = {
      documentId: event.documentId,
      versionId: event.versionId,
      versionNumber: event.versionNumber,
      title: visualTitle(event.filename),
    };
  }
  return latest;
}

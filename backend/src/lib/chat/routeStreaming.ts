import type { Response } from "express";
import type { Db } from "../supabase";

type AssistantMessageTable = "chat_messages" | "word_chat_messages";

export async function reserveAssistantMessage(args: {
  db: Db;
  table: AssistantMessageTable;
  id: string;
  chatId: string;
}): Promise<unknown | null> {
  const { error } = await args.db.from(args.table).insert({
    id: args.id,
    chat_id: args.chatId,
    role: "assistant",
    content: null,
    citations: null,
  });
  return error;
}

export function createReservedAssistantMessageUpdater(args: {
  db: Db;
  table: AssistantMessageTable;
  id: string;
  chatId: string;
  enabled?: boolean;
}): (content: unknown, citations: unknown) => Promise<unknown | null> {
  return async (content, citations) => {
    if (args.enabled === false) return null;
    let lastError: unknown | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await args.db
        .from(args.table)
        .update({ content, citations })
        .eq("id", args.id)
        .eq("chat_id", args.chatId);
      lastError = result.error;
      if (!lastError) return null;
    }
    return lastError;
  };
}

export function withoutEmptyAssistantReservations<
  T extends { role?: unknown; content?: unknown },
>(messages: T[]): T[] {
  return messages.filter(
    (message) => !(message.role === "assistant" && message.content == null),
  );
}

export function openAssistantSse(res: Response): {
  signal: AbortSignal;
  write: (line: string) => boolean;
  finish: () => void;
} {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const controller = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) controller.abort();
  });

  return {
    signal: controller.signal,
    write: (line) => res.write(line),
    finish: () => {
      finished = true;
      res.end();
    },
  };
}

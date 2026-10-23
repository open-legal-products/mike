import { AppError } from "../../../lib/appError";
import { reportError } from "../../../lib/observability/sentry";
import type { Db } from "../../../lib/supabase";

type AssistantMessageTable = "chat_messages" | "word_chat_messages";

export async function reserveAssistantMessage(args: {
  db: Db;
  table: AssistantMessageTable;
  id: string;
  chatId: string;
  inputMessageId: string;
  authorUserId: string;
}): Promise<unknown | null> {
  const { error } = await args.db.from(args.table).insert({
    id: args.id,
    chat_id: args.chatId,
    role: "assistant",
    content: null,
    citations: null,
    author_user_id: args.authorUserId,
    memory_input_message_id: args.inputMessageId,
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

/** The id the request middleware minted for this response, for the SSE error frame. */
export function requestIdOf(res: { locals: Record<string, unknown> }): string | undefined {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : undefined;
}

export type AssistantMessageFailureKind =
  | "chat.message_reserve_failed"
  | "chat.message_save_failed"
  | "chat.title_failed";

/**
 * Report and log a failed write of a turn's rows: the reservation of the
 * assistant message, its final content, its title. The database's error is a
 * plain PostgREST object, which the console bridge filed as a message with no
 * stack and no code; wrapped in an AppError it carries the kind (one issue per
 * kind) and the SQLSTATE/PGRST code of the cause, and the same object goes to
 * the log so the bridge recognises it as already sent. Returns the wrapper.
 */
export function logAssistantMessageFailure(args: {
  kind: AssistantMessageFailureKind;
  label: string;
  cause: unknown;
  component: "chat-stream" | "assistant-chat" | "word-chat";
}): AppError {
  const failure =
    args.cause instanceof AppError
      ? args.cause
      : new AppError(args.kind, args.label, { cause: args.cause });
  reportError(failure, { tags: { component: args.component } });
  console.error(args.label, failure);
  return failure;
}

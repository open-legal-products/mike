// Audit history of user actions -> public.audit_events (see the 20260728
// migration). Fire-and-forget by design: recording an event must NEVER throw
// or block the user-facing path — failures are logged and swallowed.

import { enqueueDbJob } from "./dbq/enqueue";
import type { Db } from "./supabase";

export type AuditStatus = "completed" | "cancelled" | "failed";

export type AuditEventInput = {
  userId: string;
  userEmail?: string | null;
  action: string;
  status?: AuditStatus;
  title?: string | null;
  surface?: string | null;
  projectId?: string | null;
  chatId?: string | null;
  documentId?: string | null;
  reviewId?: string | null;
  model?: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * The raw insert, THROWING on failure. Used by the durable job handler,
 * where a throw is the retry signal. User-facing paths go through
 * recordAudit below, which keeps the never-throw contract.
 */
export async function insertAuditEvent(
  db: Db,
  event: AuditEventInput,
): Promise<void> {
  const { error } = await db.from("audit_events").insert({
    user_id: event.userId,
    user_email: event.userEmail ?? null,
    action: event.action,
    status: event.status ?? "completed",
    title: event.title?.slice(0, 300) ?? null,
    surface: event.surface ?? null,
    project_id: event.projectId ?? null,
    chat_id: event.chatId ?? null,
    document_id: event.documentId ?? null,
    review_id: event.reviewId ?? null,
    model: event.model ?? null,
    detail: event.detail ?? null,
  });
  if (error) throw new Error(`[audit] insert failed: ${error.message}`);
}

export async function recordAudit(db: Db, event: AuditEventInput): Promise<void> {
  try {
    await insertAuditEvent(db, event);
  } catch (err) {
    console.error("[audit] insert threw:", err instanceof Error ? err.message : err);
  }
}

/** Shape of the persisted assistant events we mine for artifact actions. */
type TurnEvent = {
  type?: string;
  filename?: string;
  document_id?: string;
  title?: string;
  workflow_id?: string;
  // doc_replicated nests each produced copy under `copies` (see the
  // AssistantEvent union in chat/streaming.ts); the top-level `filename` is the
  // *source* document and there is no top-level document_id.
  copies?: Array<{
    new_filename?: string;
    document_id?: string;
    version_id?: string;
  }>;
};

export type ChatTurnAuditBase = {
  userId: string;
  userEmail?: string | null;
  chatId: string | null;
  projectId?: string | null;
  title?: string | null;
  model?: string | null;
  status?: AuditStatus;
  flags?: Record<string, unknown>;
  /**
   * Explicit surface, overriding the projectId-derived default below. Turns
   * that come from neither the web assistant nor a project — the Word add-in,
   * whose chats live in word_chats and carry no chats/projects row — set this
   * so their rows stay distinguishable in the history feed. Unset everywhere
   * else, which keeps the derived behavior exactly as it was.
   */
  surface?: string | null;
};

/**
 * Map one chat turn to the audit rows it should produce: a chat.message row
 * plus one row per artifact (generated/edited/replicated documents, applied
 * workflows). Pure, so the direct path and the durable job handler cannot
 * drift apart on what a turn's audit trail looks like.
 */
export function chatTurnAuditEvents(
  base: ChatTurnAuditBase,
  events: unknown[] | null | undefined,
): AuditEventInput[] {
  const surface = base.surface ?? (base.projectId ? "project" : "assistant");
  const rows: AuditEventInput[] = [
    {
      userId: base.userId,
      userEmail: base.userEmail,
      action: "chat.message",
      status: base.status ?? "completed",
      title: base.title,
      surface,
      projectId: base.projectId ?? null,
      chatId: base.chatId,
      model: base.model,
      detail: base.flags && Object.keys(base.flags).length ? base.flags : null,
    },
  ];
  for (const raw of events ?? []) {
    const ev = raw as TurnEvent;
    // A single doc_replicated event can produce several copies; emit one
    // document.generated row per copy, reading the copy's own new_filename and
    // document_id rather than the (source) top-level filename / absent id.
    if (ev?.type === "doc_replicated") {
      for (const copy of ev.copies ?? []) {
        rows.push({
          userId: base.userId,
          userEmail: base.userEmail,
          action: "document.generated",
          title: copy.new_filename ?? null,
          surface,
          projectId: base.projectId ?? null,
          chatId: base.chatId,
          documentId: copy.document_id ?? null,
          model: base.model,
          detail: null,
        });
      }
      continue;
    }
    const action =
      ev?.type === "doc_created"
        ? "document.generated"
        : ev?.type === "doc_edited"
          ? "document.edited"
          : ev?.type === "workflow_applied"
            ? "workflow.applied"
            : null;
    if (!action) continue;
    rows.push({
      userId: base.userId,
      userEmail: base.userEmail,
      action,
      title: ev.filename ?? ev.title ?? null,
      surface,
      projectId: base.projectId ?? null,
      chatId: base.chatId,
      documentId: ev.document_id ?? null,
      model: base.model,
      detail: ev.workflow_id ? { workflow_id: ev.workflow_id } : null,
    });
  }
  return rows;
}

/**
 * Record one chat turn directly (1 + N sequential inserts, errors swallowed
 * per row). Kept as the fallback when the durable enqueue below cannot reach
 * the database, and for the tests that pin the row mapping.
 */
export async function recordChatTurn(
  db: Db,
  base: ChatTurnAuditBase,
  events: unknown[] | null | undefined,
): Promise<void> {
  for (const event of chatTurnAuditEvents(base, events)) {
    await recordAudit(db, event);
  }
}

/**
 * Durable entry point for chat-turn audit, used by the chat routes.
 *
 * WHY: the direct path runs 1 + N sequential fire-and-forget inserts AFTER
 * the SSE stream's [DONE] is written — the most likely moment for the
 * process to be torn down — and every failed insert is silently dropped.
 * Enqueuing collapses that window to ONE small insert; the DB-queue worker
 * then performs the fan-out with retries, surviving restarts.
 *
 * At-least-once caveat: a retry after a partial fan-out can duplicate an
 * audit row. For an audit trail, a rare duplicate beats a silent gap.
 *
 * Never throws (audit must never break the user path): if the enqueue
 * itself fails, fall back to the direct path — exactly today's behavior.
 */
export async function enqueueChatTurnAudit(
  db: Db,
  base: ChatTurnAuditBase,
  events: unknown[] | null | undefined,
): Promise<void> {
  try {
    await enqueueDbJob(db, {
      kind: "audit.chat_turn",
      payload: { base, events: events ?? [] },
    });
  } catch (err) {
    console.error(
      "[audit] chat-turn enqueue failed; falling back to direct inserts:",
      err instanceof Error ? err.message : err,
    );
    await recordChatTurn(db, base, events);
  }
}

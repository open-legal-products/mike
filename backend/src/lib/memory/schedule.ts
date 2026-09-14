import { randomUUID } from "node:crypto";
import { envInt } from "../runtimeConfig";
import type { Db } from "../dbq/types";
import { redisEnabled } from "../dbq/driver";
import { enqueueAppJobDelivery } from "../queue/appJobsQueue";
import type { MemorySurface } from "./files";

export const MEMORY_INACTIVITY_MS =
  envInt("MEMORY_INACTIVITY_SECONDS", 300) * 1_000;
const MEMORY_INACTIVITY_SECONDS = Math.max(
  1,
  Math.min(3_600, Math.ceil(MEMORY_INACTIVITY_MS / 1_000)),
);
const MEMORY_ACTIVE_LEASE_SECONDS = envInt(
  "MEMORY_ACTIVE_LEASE_SECONDS",
  1_800,
);

export type ScheduledMemoryConsolidation = {
  job_id: string;
  generation: number;
};

export type MemoryConversationTurn = {
  activityId: string;
};

/**
 * Fence an active response before the model starts. Leases are per turn, so
 * concurrent collaborators/tabs cannot clear each other's inactivity gate.
 *
 * A failure degrades rather than aborts the turn. Memory is optional context
 * and the user's message is already persisted by the time this runs, so a
 * 500 here would strand that message without an answer. Skipping the lease
 * is safe: without it this turn is never scheduled as a learning checkpoint,
 * and an older curator can only ever learn from turns that were already
 * complete when it was scheduled. The next successful turn picks the missed
 * transcript up again because curation always re-reads the whole eligible
 * conversation.
 */
export async function beginMemoryConversationTurn(args: {
  db: Db;
  surface: MemorySurface;
  conversationId: string;
  actorUserId: string;
}): Promise<MemoryConversationTurn | null> {
  if (process.env.DB_JOBS_ENABLED === "false") return null;
  const activityId = randomUUID();
  try {
    const { error } = await args.db.rpc("begin_memory_conversation_turn", {
      p_surface: args.surface,
      p_conversation_id: args.conversationId,
      p_actor_user_id: args.actorUserId,
      p_activity_id: activityId,
      p_lease_seconds: Math.max(
        60,
        Math.min(14_400, MEMORY_ACTIVE_LEASE_SECONDS),
      ),
      p_quiet_seconds: MEMORY_INACTIVITY_SECONDS,
    });
    if (error) throw error;
  } catch {
    // Never leak DB internals; the ids are enough to correlate with the
    // database log.
    console.warn("[memory] activity lease skipped; turn will not be curated", {
      surface: args.surface,
      conversationId: args.conversationId,
    });
    return null;
  }
  return { activityId };
}

/** Release one unsuccessful/cancelled/paused turn without consuming earlier
 * successful cursors. The database starts a fresh quiet window for them. */
export async function releaseMemoryConversationTurn(args: {
  db: Db;
  surface: MemorySurface;
  conversationId: string;
  turn: MemoryConversationTurn | null;
}): Promise<void> {
  if (!args.turn || process.env.DB_JOBS_ENABLED === "false") return;
  const { error } = await args.db.rpc("release_memory_conversation_turn", {
    p_surface: args.surface,
    p_conversation_id: args.conversationId,
    p_activity_id: args.turn.activityId,
    p_quiet_seconds: MEMORY_INACTIVITY_SECONDS,
  });
  if (error) throw new Error("Memory activity could not be released");
}

/**
 * Schedule the separate curator only after a successful assistant turn is
 * durably saved. The database advances the shared quiet window and re-arms
 * every actor's still-unprocessed successful cursor; failed/cancelled/input
 * continuations never erase earlier eligible work.
 */
export async function scheduleMemoryConsolidation(args: {
  db: Db;
  surface: MemorySurface;
  conversationId: string;
  actorUserId: string;
  projectId?: string | null;
  turnId: string;
  turn: MemoryConversationTurn | null;
}): Promise<ScheduledMemoryConsolidation | null> {
  // DB_JOBS_ENABLED=false is an operational escape hatch. Do not mark files
  // scheduled when no worker can ever consume the outbox row.
  if (process.env.DB_JOBS_ENABLED === "false") return null;
  if (!args.turn) return null;
  try {
    const { data, error } = await args.db.rpc("schedule_memory_consolidation", {
      p_surface: args.surface,
      p_conversation_id: args.conversationId,
      p_actor_user_id: args.actorUserId,
      p_project_id: args.projectId ?? null,
      p_turn_id: args.turnId,
      p_activity_id: args.turn.activityId,
      p_quiet_seconds: MEMORY_INACTIVITY_SECONDS,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.job_id) {
      // The database declined silently: the source row changed, the terminal
      // message was not this actor's, or the lease had already been reaped.
      // The caller releases the lease; leave a breadcrumb so a turn that is
      // never learned is at least visible in the logs.
      console.warn("[memory] no consolidation scheduled for completed turn", {
        surface: args.surface,
        conversationId: args.conversationId,
      });
      return null;
    }
    const scheduled = {
      job_id: String(row.job_id),
      generation: Number(row.generation),
    };
    if (redisEnabled()) {
      try {
        await enqueueAppJobDelivery(scheduled.job_id, {
          delayMs: MEMORY_INACTIVITY_MS,
        });
      } catch {
        // Postgres is the durable outbox; the worker poller is the backstop.
      }
    }
    return scheduled;
  } catch {
    // The caller owns the lease: it releases every turn that was not
    // scheduled, so releasing here as well would only produce a second,
    // failing release. Conversation delivery succeeds independently of
    // optional memory curation. Keep the error free of prompts, object
    // paths, and DB details.
    console.warn("[memory] curator scheduling failed", {
      surface: args.surface,
      conversationId: args.conversationId,
    });
    return null;
  }
}

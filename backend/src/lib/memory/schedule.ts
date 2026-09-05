import { randomUUID } from "node:crypto";
import { envInt } from "../runtimeConfig";
import type { Db } from "../dbq/types";
import { redisEnabled } from "../dbq/driver";
import { enqueueAppJobDelivery } from "../queue/appJobsQueue";
import type { MemorySurface } from "./files";

export const MEMORY_INACTIVITY_MS = envInt(
  "MEMORY_INACTIVITY_SECONDS",
  300,
) * 1_000;
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
 * A failure is surfaced: letting generation continue without this durable
 * fence could allow an older curator to persist while the new turn is active.
 */
export async function beginMemoryConversationTurn(args: {
  db: Db;
  surface: MemorySurface;
  conversationId: string;
  actorUserId: string;
}): Promise<MemoryConversationTurn | null> {
  if (process.env.DB_JOBS_ENABLED === "false") return null;
  const activityId = randomUUID();
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
  if (error) {
    throw new Error("Memory activity could not be fenced");
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
    if (!row?.job_id) return null;
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
    try {
      await releaseMemoryConversationTurn({
        db: args.db,
        surface: args.surface,
        conversationId: args.conversationId,
        turn: args.turn,
      });
    } catch {
      // The lease expires independently. Never leak internal DB details.
    }
    // Conversation delivery succeeds independently of optional memory
    // curation. Keep the error free of prompts, object paths, and DB details.
    console.warn("[memory] curator scheduling failed", {
      surface: args.surface,
      conversationId: args.conversationId,
    });
    return null;
  }
}

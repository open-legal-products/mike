import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueAppJobDelivery, redisEnabled } = vi.hoisted(() => ({
  enqueueAppJobDelivery: vi.fn(),
  redisEnabled: vi.fn(() => false),
}));

vi.mock("../../queue/appJobsQueue", () => ({
  enqueueAppJobDelivery: (...args: unknown[]) => enqueueAppJobDelivery(...args),
}));
vi.mock("../../dbq/driver", () => ({
  redisEnabled: () => redisEnabled(),
}));

import {
  beginMemoryConversationTurn,
  MEMORY_INACTIVITY_MS,
  releaseMemoryConversationTurn,
  scheduleMemoryConsolidation,
} from "../schedule";

beforeEach(() => {
  enqueueAppJobDelivery.mockReset();
  redisEnabled.mockReset();
  redisEnabled.mockReturnValue(false);
});

describe("scheduleMemoryConsolidation", () => {
  it("durably records a per-turn lease before generation begins", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: null,
    }));
    const result = await beginMemoryConversationTurn({
      db: { rpc } as never,
      surface: "chat",
      conversationId: "chat-1",
      actorUserId: "user-1",
    });
    expect(result?.activityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(rpc).toHaveBeenCalledWith("begin_memory_conversation_turn", {
      p_surface: "chat",
      p_conversation_id: "chat-1",
      p_actor_user_id: "user-1",
      p_activity_id: result?.activityId,
      p_lease_seconds: 1_800,
      p_quiet_seconds: 300,
    });
  });

  it("fails closed with a safe error when the active lease cannot be fenced", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: "raw database internals" },
    }));
    await expect(
      beginMemoryConversationTurn({
        db: { rpc } as never,
        surface: "chat",
        conversationId: "chat-1",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow("Memory activity could not be fenced");
  });

  it("uses the approved five-minute quiet window", async () => {
    expect(MEMORY_INACTIVITY_MS).toBe(300_000);
    const rpc = vi.fn(async () => ({
      data: [{ job_id: "job-1", generation: 3 }],
      error: null,
    }));
    const result = await scheduleMemoryConsolidation({
      db: { rpc } as never,
      surface: "chat",
      conversationId: "00000000-0000-4000-8000-000000000001",
      actorUserId: "00000000-0000-4000-8000-000000000002",
      projectId: "00000000-0000-4000-8000-000000000003",
      turnId: "00000000-0000-4000-8000-000000000004",
      turn: {
        activityId: "00000000-0000-4000-8000-000000000005",
      },
    });
    expect(result).toEqual({ job_id: "job-1", generation: 3 });
    expect(rpc).toHaveBeenCalledWith("schedule_memory_consolidation", {
      p_surface: "chat",
      p_conversation_id: "00000000-0000-4000-8000-000000000001",
      p_actor_user_id: "00000000-0000-4000-8000-000000000002",
      p_project_id: "00000000-0000-4000-8000-000000000003",
      p_activity_id: "00000000-0000-4000-8000-000000000005",
      p_turn_id: "00000000-0000-4000-8000-000000000004",
      p_quiet_seconds: 300,
    });
  });

  it("releases only its own unsuccessful turn lease", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await releaseMemoryConversationTurn({
      db: { rpc } as never,
      surface: "tabular",
      conversationId: "chat-1",
      turn: { activityId: "activity-1" },
    });
    expect(rpc).toHaveBeenCalledWith("release_memory_conversation_turn", {
      p_surface: "tabular",
      p_conversation_id: "chat-1",
      p_activity_id: "activity-1",
      p_quiet_seconds: 300,
    });
  });

  it("keeps Postgres authoritative and treats Redis delivery as best effort", async () => {
    redisEnabled.mockReturnValue(true);
    enqueueAppJobDelivery.mockRejectedValue(new Error("redis unavailable"));
    const rpc = vi.fn(async () => ({
      data: [{ job_id: "job-1", generation: 1 }],
      error: null,
    }));
    await expect(
      scheduleMemoryConsolidation({
        db: { rpc } as never,
        surface: "word",
        conversationId: "chat",
        actorUserId: "user",
        turnId: "turn",
        turn: { activityId: "activity" },
      }),
    ).resolves.toEqual({ job_id: "job-1", generation: 1 });
    expect(enqueueAppJobDelivery).toHaveBeenCalledWith("job-1", {
      delayMs: expect.any(Number),
    });
  });

  it("does not create stuck scheduled state when DB jobs are disabled", async () => {
    const previous = process.env.DB_JOBS_ENABLED;
    process.env.DB_JOBS_ENABLED = "false";
    const rpc = vi.fn();
    try {
      await expect(
        scheduleMemoryConsolidation({
          db: { rpc } as never,
          surface: "chat",
          conversationId: "chat",
          actorUserId: "user",
          turnId: "turn",
          turn: { activityId: "activity" },
        }),
      ).resolves.toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.DB_JOBS_ENABLED;
      else process.env.DB_JOBS_ENABLED = previous;
    }
  });
});

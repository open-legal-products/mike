import { beforeEach, describe, expect, it } from "vitest";
import { consumeAuthHandoff, issueAuthHandoff } from "../authHandoff";

describe("Word OAuth handoff tickets", () => {
  beforeEach(() => {
    process.env.AUTH_HANDOFF_ENCRYPTION_SECRET = "x".repeat(48);
  });

  it("stores encrypted session data and consumes a ticket only once", async () => {
    let stored: Record<string, unknown> | null = null;
    let consumed = false;
    const database = {
      from: () => ({
        delete: () => ({
          lt: async () => ({ error: null }),
        }),
        insert: async (row: Record<string, unknown>) => {
          stored = row;
          return { error: null };
        },
        update: () => {
          const chain = {
            eq: () => chain,
            is: () => chain,
            gt: () => chain,
            select: () => chain,
            maybeSingle: async () => {
              if (consumed || !stored) return { data: null, error: null };
              consumed = true;
              return { data: stored, error: null };
            },
          };
          return chain;
        },
      }),
    };
    const session = {
      access_token: "raw-access-token",
      refresh_token: "raw-refresh-token",
    };

    const ticket = await issueAuthHandoff({
      userId: "user-1",
      requestId: "request-id-123456",
      origin: "https://word.example.test",
      session: session as never,
      db: database as never,
    });

    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(session.access_token);
    expect(JSON.stringify(stored)).not.toContain(session.refresh_token);
    expect((stored as Record<string, unknown> | null)?.ticket_hash).not.toBe(
      ticket,
    );

    await expect(
      consumeAuthHandoff({
        ticket,
        requestId: "request-id-123456",
        origin: "https://word.example.test",
        db: database as never,
      }),
    ).resolves.toEqual({
      userId: "user-1",
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    });

    await expect(
      consumeAuthHandoff({
        ticket,
        requestId: "request-id-123456",
        origin: "https://word.example.test",
        db: database as never,
      }),
    ).resolves.toBeNull();
  });
});

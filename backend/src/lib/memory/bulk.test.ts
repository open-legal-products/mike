import { describe, expect, it, vi } from "vitest";
import { deleteUserPrivateMemories } from "./bulk";

describe("deleteUserPrivateMemories", () => {
  it("delegates the complete private-memory wipe to one database transaction", async () => {
    const rpc = vi.fn(async () => ({ data: 2, error: null }));
    const db = { rpc };

    await expect(
      deleteUserPrivateMemories(db as never, "u1", null),
    ).resolves.toEqual({ projectMemoriesDeleted: 2 });
    expect(rpc).toHaveBeenCalledWith("delete_user_private_memories", {
      p_user_id: "u1",
      p_org_id: null,
    });
  });

  it("names the organization whose memory is wiped", async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));

    await deleteUserPrivateMemories({ rpc } as never, "u1", "org-1");
    expect(rpc).toHaveBeenCalledWith("delete_user_private_memories", {
      p_user_id: "u1",
      p_org_id: "org-1",
    });
  });

  it("fails the request when the database transaction fails", async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { message: "rolled back" },
      })),
    };

    await expect(deleteUserPrivateMemories(db as never, "u1", null)).rejects.toThrow(
      "Failed to delete private memories",
    );
  });
});

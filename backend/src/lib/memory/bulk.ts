import type { Db } from "../dbq/types";

/**
 * Delete a person's own memory for one workspace — `orgId`, or Personal when
 * null — without reaching into an organization's data or a project that
 * merely happens to be shared with this user. Private project memories are
 * Personal's, so only a Personal delete reaches them.
 */
export async function deleteUserPrivateMemories(
  db: Db,
  userId: string,
  orgId: string | null,
): Promise<{ projectMemoriesDeleted: number }> {
  const { data, error } = await db.rpc("delete_user_private_memories", {
    p_user_id: userId,
    p_org_id: orgId,
  });
  if (error) throw new Error("Failed to delete private memories");
  return {
    projectMemoriesDeleted:
      typeof data === "number" && Number.isSafeInteger(data) ? data : 0,
  };
}

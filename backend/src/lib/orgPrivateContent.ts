import type { OrgPrivateContentKind } from "@mike/contracts";
import type { Db } from "./supabase";

/** Permission alone never opens content: the member must explicitly open it. */
export async function hasOrgPrivateContentAccess(
  db: Db,
  orgId: string | null | undefined,
  userId: string,
  kind: OrgPrivateContentKind,
  itemId: string | null | undefined,
): Promise<boolean> {
  if (!orgId || !itemId) return false;
  const { data, error } =
    kind === "document"
      ? await db.rpc("org_private_document_access", {
          p_org_id: orgId,
          p_document_id: itemId,
          p_user_id: userId,
        })
      : await db.rpc("org_private_access_role", {
          p_org_id: orgId,
          p_kind: kind,
          p_item_id: itemId,
          p_user_id: userId,
        });
  if (error) return false;
  return kind === "document" ? data === true : data === "viewer";
}

/** Directory/export lists use the same live verdict as single-item reads. */
export async function listOrgPrivateContentAccess(
  db: Db,
  orgIds: string[],
  userId: string,
): Promise<Map<OrgPrivateContentKind, Set<string>>> {
  const result = new Map<OrgPrivateContentKind, Set<string>>();
  if (!orgIds.length) return result;
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.rpc("list_org_private_content_access", {
      p_org_ids: orgIds,
      p_user_id: userId,
      p_offset: offset,
    });
    if (error) throw new Error("Could not read private content access");
    const rows = (data ?? []) as {
      kind: OrgPrivateContentKind;
      item_id: string;
    }[];
    for (const row of rows) {
      if (!result.has(row.kind)) result.set(row.kind, new Set());
      result.get(row.kind)!.add(row.item_id);
    }
    if (rows.length < 500) return result;
  }
}

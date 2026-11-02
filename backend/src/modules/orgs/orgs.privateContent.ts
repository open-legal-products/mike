import type {
  OrgPrivateContentItem,
  OrgPrivateContentKind,
  OrgPrivateContentPage,
} from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

const KINDS = new Set<OrgPrivateContentKind>([
  "project",
  "workflow",
  "chat",
  "tabular_review",
  "document",
]);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
type Actor = { orgId: string; userId: string };
type RpcError = { code?: string; message?: string };

function rpcFailure(error: RpcError) {
  if (error.code === "42501")
    return failure(
      "forbidden",
      "You do not have permission to access private organization content.",
    );
  if (error.code === "P0002")
    return failure("not_found", "Organization or item not found.");
  if (error.code === "23514" || error.code === "22P02")
    return failure(
      "validation",
      "Choose a valid item or current organization admin.",
    );
  return internalFailure(error);
}

export async function listPrivateContent(
  db: Db,
  actor: Actor & { limit: number; offset: number; search?: unknown },
): Promise<ServiceResult<OrgPrivateContentPage>> {
  if (actor.search !== undefined && typeof actor.search !== "string")
    return failure("validation", "Enter a search term.");
  const { data, error } = await db.rpc("list_org_private_content", {
    p_org_id: actor.orgId,
    p_actor_id: actor.userId,
    p_limit: actor.limit + 1,
    p_offset: actor.offset,
    p_search: String(actor.search ?? "")
      .trim()
      .slice(0, 200),
  });
  if (error) return rpcFailure(error);
  const items = (data ?? []) as OrgPrivateContentItem[];
  return ok({
    items: items.slice(0, actor.limit),
    nextOffset: items.length > actor.limit ? actor.offset + actor.limit : null,
  });
}

export async function setPrivateContentPermission(
  db: Db,
  actor: Actor & { targetUserId: string; enabled: unknown },
): Promise<ServiceResult<null>> {
  if (!UUID.test(actor.targetUserId) || typeof actor.enabled !== "boolean")
    return failure(
      "validation",
      "Choose an admin and whether access is enabled.",
    );
  const { error } = await db.rpc("set_org_private_content_permission", {
    p_org_id: actor.orgId,
    p_actor_id: actor.userId,
    p_target_id: actor.targetUserId,
    p_enabled: actor.enabled,
  });
  return error ? rpcFailure(error) : ok(null);
}

export async function changePrivateContentAccess(
  db: Db,
  actor: Actor & { kind: string; itemId: string; open: boolean },
): Promise<ServiceResult<null>> {
  if (
    !KINDS.has(actor.kind as OrgPrivateContentKind) ||
    !UUID.test(actor.itemId)
  )
    return failure("validation", "Choose a valid organization item.");
  const { error } = await db.rpc(
    actor.open ? "open_org_private_content" : "close_org_private_content",
    {
      p_org_id: actor.orgId,
      p_actor_id: actor.userId,
      p_kind: actor.kind,
      p_item_id: actor.itemId,
    },
  );
  return error ? rpcFailure(error) : ok(null);
}

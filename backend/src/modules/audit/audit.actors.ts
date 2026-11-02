import type { AuditActor, AuditActorPage } from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import { canReadOrgAudit, parseQuery } from "../../lib/auditExport";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

const PAGE_SIZE = 20;

/** Search only identities with events in an organization the caller administers. */
export async function listAuditActors(
  db: Db,
  args: { userId: string; query: Record<string, unknown> },
): Promise<ServiceResult<AuditActorPage>> {
  const parsed = parseQuery(args.query, PAGE_SIZE);
  if (!parsed.ok) return failure("validation", parsed.error);
  const { orgId, q } = parsed.query;
  if (!orgId) return failure("validation", "An organization is required.");
  if (args.query.q !== undefined && typeof args.query.q !== "string")
    return failure("validation", "Invalid search.");
  const rawOffset = args.query.offset ?? "0";
  const offset = Number(rawOffset);
  if (
    typeof rawOffset !== "string" ||
    !/^\d+$/.test(rawOffset) ||
    !Number.isSafeInteger(offset) ||
    offset > 1_000_000
  )
    return failure("validation", "Invalid pagination offset.");
  if (!(await canReadOrgAudit(db, args.userId, orgId)))
    return failure(
      "forbidden",
      "Only organization owners and admins can view its audit log.",
    );
  const { data, error } = await db.rpc("organization_audit_actors", {
    p_org_id: orgId,
    p_actor_id: args.userId,
    p_search: q ?? "",
    p_offset: offset,
    p_limit: PAGE_SIZE + 1,
  });
  if (error) return internalFailure(error);
  const users = (data ?? []) as AuditActor[];
  return ok({
    users: users.slice(0, PAGE_SIZE),
    nextOffset: users.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
  });
}

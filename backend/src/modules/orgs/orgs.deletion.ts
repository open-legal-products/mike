// Organization deletion suspends the organization for its recovery period.
import { deleteOrg as deleteOrgRow, type OrgResult } from "../../lib/orgs";
import type { Db } from "../../lib/supabase";
interface OrgActor { userId: string; userEmail?: string | null; orgId: string; }
type Done = OrgResult<Record<never, never>>;
/** Suspend the organization for its 30-day recovery period. */
export function deleteOrg(db: Db, params: OrgActor): Promise<Done> {
    return deleteOrgRow(db, params);
}

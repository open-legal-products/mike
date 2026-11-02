import type { Db } from "./supabase";

type ResourceKind = "project" | "workflow";

export type AccessSummaryRow = {
  id: string;
  org_id?: string | null;
  access_scope?: unknown;
  organization_name?: unknown;
  direct_grant_count?: unknown;
  [key: string]: unknown;
};

type AccessSummaryResult<T extends AccessSummaryRow> =
  | { rows: T[]; error: null }
  | { rows: T[]; error: unknown };

function hasCompleteAccessScope(row: AccessSummaryRow) {
  if (row.access_scope === "organization") {
    return (
      typeof row.org_id === "string" &&
      typeof row.organization_name === "string" &&
      row.organization_name.trim().length > 0
    );
  }
  // Personal or an organization's: an organization's item is private until
  // it is opened to everyone, so these two say nothing about org_id. (They
  // once did — an organization's item could only be 'organization' — and a
  // private one was then "repaired" below into a public one.)
  return row.access_scope === "private" || row.access_scope === "shared";
}

function hasCompleteDirectGrantCount(row: AccessSummaryRow) {
  return (
    row.access_scope !== "shared" ||
    (typeof row.direct_grant_count === "number" &&
      Number.isInteger(row.direct_grant_count) &&
      row.direct_grant_count >= 0)
  );
}

/**
 * Backfills access metadata when an existing deployment is briefly serving an
 * older overview RPC during a rolling migration. This stays page-batched: it
 * never performs one request per resource.
 */
export async function ensureResourceAccessSummaries<T extends AccessSummaryRow>(
  db: Db,
  kind: ResourceKind,
  rows: T[],
): Promise<AccessSummaryResult<T>> {
  if (
    rows.length === 0 ||
    (rows.every(hasCompleteAccessScope) &&
      rows.every(hasCompleteDirectGrantCount))
  ) {
    return { rows, error: null };
  }

  const ids = rows.map((row) => row.id);
  const resourceTable = kind === "project" ? "projects" : "workflows";
  const grantTable =
    kind === "project" ? "project_access_grants" : "workflow_shares";
  // Inside an organization an item is shared through per-member roles, not
  // direct grants. A 'deny' is not sharing.
  const overrideTable =
    kind === "project"
      ? "project_org_access_overrides"
      : "workflow_org_access_overrides";
  const grantResourceKey = kind === "project" ? "project_id" : "workflow_id";
  const sharedInAnOrganization = rows.some(
    (row) => row.access_scope === "shared" && typeof row.org_id === "string",
  );

  const accessScopesComplete = rows.every(hasCompleteAccessScope);
  const [resourceResult, grantResult, overrideResult] = await Promise.all([
    accessScopesComplete
      ? Promise.resolve({ data: [], error: null })
      : db.from(resourceTable).select("id, org_id").in("id", ids),
    db.from(grantTable).select(grantResourceKey).in(grantResourceKey, ids),
    sharedInAnOrganization
      ? db
          .from(overrideTable)
          .select(`${grantResourceKey}, role`)
          .in(grantResourceKey, ids)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (resourceResult.error) return { rows, error: resourceResult.error };
  if (grantResult.error) return { rows, error: grantResult.error };
  if (overrideResult.error) return { rows, error: overrideResult.error };

  const resources = Array.isArray(resourceResult.data)
    ? (resourceResult.data as { id: string; org_id?: string | null }[])
    : [];
  const resourceById = new Map(
    resources.map((resource) => [resource.id, resource]),
  );
  const directGrantCountById = new Map<string, number>();
  for (const grant of Array.isArray(grantResult.data) ? grantResult.data : []) {
    const id = (grant as Record<string, unknown>)[grantResourceKey];
    if (typeof id !== "string") continue;
    directGrantCountById.set(id, (directGrantCountById.get(id) ?? 0) + 1);
  }
  const grantedIds = new Set(directGrantCountById.keys());
  for (const override of Array.isArray(overrideResult.data)
    ? overrideResult.data
    : []) {
    const { role, [grantResourceKey]: id } = override as Record<string, unknown>;
    if (typeof id !== "string" || role === "deny") continue;
    directGrantCountById.set(id, (directGrantCountById.get(id) ?? 0) + 1);
  }

  if (accessScopesComplete) {
    return {
      rows: rows.map((row) =>
        row.access_scope === "shared"
          ? ({
              ...row,
              direct_grant_count: directGrantCountById.get(row.id) ?? 0,
            } as T)
          : row,
      ),
      error: null,
    };
  }
  const orgIds = [
    ...new Set(
      resources
        .map((resource) => resource.org_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  let organizationById = new Map<string, string>();
  if (orgIds.length > 0) {
    const organizationResult = await db
      .from("organizations")
      .select("id, name")
      .in("id", orgIds);
    if (organizationResult.error) {
      return { rows, error: organizationResult.error };
    }
    organizationById = new Map(
      (Array.isArray(organizationResult.data) ? organizationResult.data : [])
        .filter(
          (organization): organization is { id: string; name: string } =>
            typeof organization.id === "string" &&
            typeof organization.name === "string",
        )
        .map((organization) => [organization.id, organization.name]),
    );
  }

  return {
    rows: rows.map((row) => {
      const resource = resourceById.get(row.id);
      if (!resource) return row;
      const orgId = resource.org_id ?? null;
      const accessScope = orgId
        ? "organization"
        : grantedIds.has(row.id)
          ? "shared"
          : "private";
      return {
        ...row,
        org_id: orgId,
        access_scope: accessScope,
        organization_name: orgId ? (organizationById.get(orgId) ?? null) : null,
        ...(accessScope === "shared"
          ? { direct_grant_count: directGrantCountById.get(row.id) ?? 0 }
          : {}),
      };
    }),
    error: null,
  };
}

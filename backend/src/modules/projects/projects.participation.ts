import type { Db } from "../../lib/supabase";
import { internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

export type ProjectParticipationRow = {
  id: string;
  user_id?: string | null;
  org_id?: string | null;
};

/**
 * Keep created or explicitly shared projects, whether public or private.
 * Public visibility and inherited owner/admin access are not participation.
 */
export async function filterParticipatingProjects<T extends ProjectParticipationRow>(
  db: Db,
  projects: T[],
  userId: string,
  userEmail?: string,
): Promise<ServiceResult<T[]>> {
  const participating = new Set(
    projects.filter(project => project.user_id === userId).map(project => project.id),
  );
  const email = userEmail?.trim().toLowerCase();
  for (const organization of [false, true]) {
    if (!organization && !email) continue;
    const candidates = projects.filter(project =>
      !participating.has(project.id) && Boolean(project.org_id) === organization,
    );
    // Bound the URL and response size. Each recipient has at most one grant
    // per project, so these batches cannot hit PostgREST's default row cap.
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const ids = candidates.slice(offset, offset + 100).map(project => project.id);
      const query = organization
        ? db.from("project_org_access_overrides").select("project_id")
            .eq("user_id", userId).in("role", ["owner", "editor", "viewer"])
        : db.from("project_access_grants").select("project_id").eq("email", email!);
      const { data, error } = await query.in("project_id", ids);
      if (error) return internalFailure(error);
      for (const row of data ?? []) participating.add(row.project_id);
    }
  }
  // The original list has already checked current membership, revocations,
  // archives and access rules. A grant alone can never add a project to it.
  return ok(projects.filter(project => participating.has(project.id)));
}

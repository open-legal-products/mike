import { checkProjectAccess, listAccessibleProjectIds } from "../access";
import { chunkArray } from "../arrays";
import type { Db } from "../dbq/types";
import { getMemoryCurrent } from "./files";

const PROJECT_BATCH_SIZE = 200;

type ProjectLabel = {
  id: string;
  name: string | null;
  org_id: string | null;
};

function archiveSegment(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/]/g, "-")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "-")
    .replace(/\.{2,}/g, "-")
    .trim()
    .replace(/[. ]+$/g, "");
  return Array.from(normalized || "project")
    .slice(0, 80)
    .join("");
}

async function loadProjectLabels(
  db: Db,
  projectIds: string[],
): Promise<ProjectLabel[]> {
  const projects: ProjectLabel[] = [];
  for (const batch of chunkArray(projectIds, PROJECT_BATCH_SIZE)) {
    const { data, error } = await db
      .from("projects")
      .select("id, name, org_id")
      .in("id", batch);
    if (error) throw new Error("Failed to load projects for memory export");
    projects.push(...((data ?? []) as ProjectLabel[]));
  }
  return projects.sort(
    (left, right) =>
      (left.name ?? "").localeCompare(right.name ?? "") ||
      left.id.localeCompare(right.id),
  );
}

/** The caller's organization name, for the archive's folder. */
async function organizationName(db: Db, orgId: string): Promise<string | null> {
  const { data, error } = await db
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error("Failed to load organization for memory export");
  return (data as { name?: string | null } | null)?.name ?? null;
}

/**
 * Build a ZIP of one workspace's memory: the caller's own memory there, and
 * every project memory in it they can still view when the background export
 * actually runs. `orgId` names the organization; null is Personal.
 */
export async function buildMemoryArchive(
  db: Db,
  userId: string,
  userEmail: string | null,
  orgId: string | null = null,
): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const ownMemory = await getMemoryCurrent(db, "user", userId, orgId);
  if (orgId) {
    const safeId = orgId.replace(/[^a-zA-Z0-9-]/g, "") || "organization";
    const name = await organizationName(db, orgId);
    const directory = `${archiveSegment(name ?? "organization")}--${safeId}`;
    zip.file(`organizations/${directory}/memory.md`, ownMemory.current.content);
  } else {
    zip.file("app/memory.md", ownMemory.current.content);
  }

  const projectIds = await listAccessibleProjectIds(userId, userEmail, db);
  const projects = (await loadProjectLabels(db, projectIds)).filter(
    (project) => (project.org_id ?? null) === orgId,
  );
  for (const project of projects) {
    // Access can change while an export waits in the durable queue. Re-check
    // immediately before reading each shared file and omit revoked projects.
    const access = await checkProjectAccess(project.id, userId, userEmail, db);
    if (!access.ok) continue;
    const memory = await getMemoryCurrent(db, "project", project.id);
    const safeId = project.id.replace(/[^a-zA-Z0-9-]/g, "") || "project";
    const directory = `${archiveSegment(project.name ?? "project")}--${safeId}`;
    zip.file(`projects/${directory}/memory.md`, memory.current.content);
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

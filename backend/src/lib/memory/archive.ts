import { listAccessibleProjectIds } from "../access";
import { selectInBatches } from "../batchedQuery";
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
  // listAccessibleProjectIds is this run's access verdict (it is computed
  // when the queued export executes, not when it was requested), so each
  // project is not re-checked one by one, and the memory bodies are read in
  // batches rather than one ensure-or-create round trip per project. A
  // project with no memory file yet exports an empty memory.md, as before,
  // without an export creating rows.
  type ProjectMemoryRow = { project_id: string; content: string | null };
  const memoryByProject = new Map(
    (
      await selectInBatches<ProjectMemoryRow>(
        "project memory export",
        projects.map((project) => project.id),
        (batch) =>
          db
            .from("memory_files")
            .select("project_id, content")
            .eq("scope", "project")
            .in("project_id", batch),
      )
    ).map((row) => [row.project_id, row.content ?? ""]),
  );
  for (const project of projects) {
    const safeId = project.id.replace(/[^a-zA-Z0-9-]/g, "") || "project";
    const directory = `${archiveSegment(project.name ?? "project")}--${safeId}`;
    zip.file(`projects/${directory}/memory.md`, memoryByProject.get(project.id) ?? "");
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

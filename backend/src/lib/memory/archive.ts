import { checkProjectAccess, listAccessibleProjectIds } from "../access";
import { chunkArray } from "../arrays";
import type { Db } from "../dbq/types";
import { getMemoryCurrent } from "./files";

const PROJECT_BATCH_SIZE = 200;

type ProjectLabel = {
  id: string;
  name: string | null;
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
      .select("id, name")
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

/** The caller's own memory for each organization they belong to. */
async function loadWorkspaceMemories(
  db: Db,
  userId: string,
): Promise<{ orgId: string; name: string | null; content: string }[]> {
  const { data, error } = await db
    .from("memory_files")
    .select("org_id, content")
    .eq("scope", "user")
    .eq("user_id", userId)
    .not("org_id", "is", null);
  if (error) {
    // A database from before memory was per workspace has only Personal.
    if (error.code === "42703" || error.code === "PGRST204") return [];
    throw new Error("Failed to load workspace memory for export");
  }
  const files = ((data ?? []) as { org_id?: string | null; content?: string }[])
    .filter((file): file is { org_id: string; content?: string } =>
      typeof file.org_id === "string",
    );
  if (files.length === 0) return [];
  const { data: organizations, error: organizationsError } = await db
    .from("organizations")
    .select("id, name")
    .is("deleted_at", null)
    .in(
      "id",
      files.map((file) => file.org_id),
    );
  if (organizationsError)
    throw new Error("Failed to load organizations for memory export");
  const nameById = new Map(
    ((organizations ?? []) as { id: string; name: string | null }[]).map(
      (organization) => [organization.id, organization.name],
    ),
  );
  return files
    .filter((file) => nameById.has(file.org_id))
    .map((file) => ({
      orgId: file.org_id,
      name: nameById.get(file.org_id) ?? null,
      content: file.content ?? "",
    }))
    .sort(
      (left, right) =>
        (left.name ?? "").localeCompare(right.name ?? "") ||
        left.orgId.localeCompare(right.orgId),
    );
}

/** Build a ZIP containing the caller's own memory — Personal, and the one
 * they have in each organization — and every project memory they can still
 * view when the background export actually runs. */
export async function buildMemoryArchive(
  db: Db,
  userId: string,
  userEmail: string | null,
): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const appMemory = await getMemoryCurrent(db, "user", userId);
  zip.file("app/memory.md", appMemory.current.content);
  for (const workspace of await loadWorkspaceMemories(db, userId)) {
    const safeId = workspace.orgId.replace(/[^a-zA-Z0-9-]/g, "") || "organization";
    const directory = `${archiveSegment(workspace.name ?? "organization")}--${safeId}`;
    zip.file(`organizations/${directory}/memory.md`, workspace.content);
  }

  const projectIds = await listAccessibleProjectIds(userId, userEmail, db);
  const projects = await loadProjectLabels(db, projectIds);
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

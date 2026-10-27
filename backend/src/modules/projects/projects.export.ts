import type { Db } from "../../lib/supabase";
import { sealManifest } from "../../lib/manifestSigning";
import { throwIfError, uniqueStrings } from "../../lib/serviceData";
import { selectAll, loadMemoryExport } from "../../lib/memory/export";
function nowStamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function idsFrom(rows: Record<string, unknown>[], column = "id"): string[] { return uniqueStrings(rows.map(row => typeof row[column] === "string" ? row[column] as string : null)); }
export function projectManifestFilename(projectId: string) {
    return `mike-project-manifest-${projectId.slice(0, 8)}-${nowStamp()}.json`;
}
/**
 * Tamper-evident manifest for one project: every document version with its
 * content_sha256, plus the accept/reject trail. To check an exported file
 * against what the workspace held, recompute its SHA-256 and compare.
 *
 * `sealManifest` then hashes the body and signs that digest with the
 * deployment's Ed25519 key, if it has one. Unsigned, the manifest shows the
 * *files* are unmodified but says nothing about itself.
 *
 * Versions written before content hashing shipped carry a null hash rather
 * than a wrong one, so an old file set reads as unverifiable and never as
 * verified.
 */
export async function buildProjectExportManifest(db: Db, projectId: string) {
    const { data: project, error: projectError } = await db
        .from("projects")
        .select("id, name, cm_number, created_at")
        .eq("id", projectId)
        .single();
    await throwIfError(projectError, "Failed to export project");

    const memory = await loadMemoryExport(db, "project", projectId);

    const documents = await selectAll(
        db,
        "documents",
        (query) =>
            query
                .eq("project_id", projectId)
                .order("created_at", { ascending: true })
                .order("id", { ascending: true }),
        "id, project_id, status, current_version_id, created_at",
    );
    const documentIds = idsFrom(documents);

    const [versions, edits] = await Promise.all([
        documentIds.length === 0
            ? Promise.resolve([])
            : selectAll(
                  db,
                  "document_versions",
                  (query) =>
                      query
                          .in("document_id", documentIds)
                          .order("created_at", { ascending: true })
                          .order("id", { ascending: true }),
                  "id, document_id, version_number, source, filename, file_type, size_bytes, content_sha256, deleted_at, created_at",
              ),
        documentIds.length === 0
            ? Promise.resolve([])
            : selectAll(
                  db,
                  "document_edits",
                  (query) =>
                      query
                          .in("document_id", documentIds)
                          .order("created_at", { ascending: true })
                          .order("id", { ascending: true }),
                  "id, document_id, version_id, change_id, status, created_at, resolved_at",
              ),
    ]);

    const groupByDocument = (rows: Record<string, unknown>[]) => {
        const byDoc = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
            const docId = row.document_id as string;
            const list = byDoc.get(docId) ?? [];
            list.push(row);
            byDoc.set(docId, list);
        }
        return byDoc;
    };
    const versionsByDoc = groupByDocument(versions);
    const editsByDoc = groupByDocument(edits);

    return sealManifest({
        manifest_version: 1,
        exported_at: new Date().toISOString(),
        project,
        memory,
        documents: documents.map((doc) => ({
            id: doc.id,
            status: doc.status,
            current_version_id: doc.current_version_id,
            created_at: doc.created_at,
            versions: (versionsByDoc.get(doc.id as string) ?? []).map((v) => ({
                id: v.id,
                version_number: v.version_number,
                source: v.source,
                filename: v.filename,
                file_type: v.file_type,
                size_bytes: v.size_bytes,
                content_sha256: v.content_sha256,
                deleted_at: v.deleted_at,
                created_at: v.created_at,
            })),
            edits: (editsByDoc.get(doc.id as string) ?? []).map((e) => ({
                id: e.id,
                version_id: e.version_id,
                change_id: e.change_id,
                status: e.status,
                created_at: e.created_at,
                resolved_at: e.resolved_at,
            })),
        })),
    });
}

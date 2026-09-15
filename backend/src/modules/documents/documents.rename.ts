// One rename operation for project and library entry points. Scope is applied
// to BOTH document queries; an id alone never authorizes a mutation.
import type { Db } from "../../lib/supabase";
import { checkProjectAccess } from "../../lib/access";
import { can } from "../../lib/permissions";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

type RenameScope =
  | { kind: "project"; projectId: string }
  | { kind: "library"; libraryKind: "file" | "template" };

type RenameArgs = {
  userId: string;
  userEmail?: string;
  documentId: string;
  scope: RenameScope;
  filename: unknown;
};

function normalizeDocumentFilename(nextName: unknown, currentName: string) {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

function scopedDocumentQuery(db: Db, args: RenameArgs, touch = false) {
  let query = (
    touch
      ? db.from("documents").update({ updated_at: new Date().toISOString() })
      : db.from("documents").select("id, current_version_id")
  ).eq("id", args.documentId);
  if (args.scope.kind === "project") {
    return query.eq("project_id", args.scope.projectId);
  }
  query = query.eq("user_id", args.userId).is("project_id", null);
  return args.scope.libraryKind === "file"
    ? query.or("library_kind.eq.file,library_kind.is.null")
    : query.eq("library_kind", args.scope.libraryKind);
}

export async function renameDocument(
  db: Db,
  args: RenameArgs,
): Promise<ServiceResult<Record<string, unknown>>> {
  if (args.scope.kind === "project") {
    const access = await checkProjectAccess(
      args.scope.projectId,
      args.userId,
      args.userEmail,
      db,
    );
    if (!access.ok || !can(access.projectRole, "docs.organize"))
      return failure("forbidden", "Project not found");
  }
  const { data } = await scopedDocumentQuery(db, args).single();
  // The query builder handles both select and update operations.
  const doc = data as { id: string; current_version_id?: string | null } | null;
  if (!doc?.current_version_id)
    return failure("not_found", "Document not found");

  const active = await db
    .from("document_versions")
    .select("filename")
    .eq("id", doc.current_version_id)
    .eq("document_id", args.documentId)
    .single();
  const currentName =
    typeof active.data?.filename === "string" && active.data.filename.trim()
      ? active.data.filename.trim()
      : "Untitled document";
  const filename = normalizeDocumentFilename(args.filename, currentName);
  if (!filename) return failure("validation", "filename is required");

  // Preserve the existing ordering and not-found policy for a failed scoped
  // document update. Updating the active version must never precede this gate.
  const { data: updated, error } = await scopedDocumentQuery(db, args, true)
    .select("*")
    .single();
  if (error || !updated) return failure("not_found", "Document not found");

  const { data: renamed, error: renameError } = await db
    .from("document_versions")
    .update({ filename })
    .eq("id", doc.current_version_id)
    .eq("document_id", args.documentId)
    .select("filename")
    .single();
  if (renameError) return internalFailure(renameError);
  if (!renamed) return failure("not_found", "Document not found");
  return ok({ ...updated, filename: renamed.filename });
}

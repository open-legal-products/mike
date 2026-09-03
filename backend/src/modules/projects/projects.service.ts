// Business logic + data-access for the projects module.
//
// These functions are the service layer behind projects.routes.ts. They take
// an explicit Supabase client (`db`) plus request-derived primitives, perform
// the project / document / folder orchestration, and RETURN values or typed
// error results. They never touch req/res — the thin route handlers map the
// results onto HTTP status codes, headers, and response bodies.
//
// The implementation is split by concern across sibling files; this module is
// the aggregate surface the routes (and tests) import from:
//
//   projects.shared.ts     — shared types + helpers (Db, normalisers, …)
//   projects.crud.ts       — overview, create, detail, people, update,
//                            delete, export manifest
//   projects.documents.ts  — list, assign/copy, rename
//   projects.folders.ts    — subfolders + moving documents between them
//   projects.chats.ts      — list a project's chats

export { normalizeOptionalString } from "./projects.shared";

export {
  getProjectsOverview,
  getProjectSummaries,
  searchProjectDirectory,
  getProjectFilterOptions,
  listProjectIds,
  createProject,
  getProjectDetail,
  getProjectPeople,
  updateProject,
  deleteProject,
  exportProjectManifest,
  type CreateProjectResult,
  type ProjectListFilters,
  type ProjectsDbFailure,
  type UpdateProjectResult,
  type ExportProjectResult,
} from "./projects.crud";

export {
  listProjectDocuments,
  getProjectDirectoryLevel,
  assignOrCopyDocument,
  renameProjectDocument,
  type AssignOrCopyResult,
  type RenameDocumentResult,
} from "./projects.documents";

export {
  createProjectFolder,
  updateProjectFolder,
  deleteProjectFolder,
  moveProjectDocument,
  resolveProjectFolderPath,
  type CreateFolderResult,
  type UpdateFolderResult,
  type DeleteFolderResult,
  type MoveDocumentResult,
  type ResolveFolderPathResult,
} from "./projects.folders";

export { listProjectChats } from "./projects.chats";

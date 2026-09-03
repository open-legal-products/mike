// Business logic + data-access for the documents module.
//
// These functions are the service layer behind documents.routes.ts. They take
// an explicit Supabase client (`db`) plus request-derived primitives, perform
// the storage / version / conversion orchestration, and RETURN values or
// typed error results. They never touch req/res — the thin route handlers map
// the results onto HTTP status codes, headers, and response bodies.
//
// This file is the module's stable facade: the implementation is decomposed
// into cohesive sibling files and re-exported here so importers never change.
//
//   documents.shared.ts    — shared types and helpers
//   documents.access.ts    — access guards + list/delete document
//   documents.download.ts  — display bytes, zip bundling, signed URLs, raw docx
//   documents.versions.ts  — version lifecycle (list/create/rename/delete)
//   documents.edits.ts     — tracked-change ids + accept/reject edits
//
// Creating a document or a version from uploaded bytes is not part of this
// module: clients upload directly to object storage through the upload-session
// protocol (modules/uploads).

export {
    getDocument,
    listSingleDocuments,
    deleteDocument,
} from "./documents.access";

export {
    getDisplayableVersion,
    collectFolderDescendantIds,
    resolveZipExportDocuments,
    getDownloadUrl,
    getDocxBytes,
} from "./documents.download";
export type { ZipExportEntry } from "./documents.download";

export {
    listVersions,
    createVersionFromDocument,
    renameVersion,
    deleteVersion,
} from "./documents.versions";

export {
    getTrackedChangeIds,
    resolveEdit,
} from "./documents.edits";

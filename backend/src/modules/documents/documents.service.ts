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
//   documents.download.ts  — display bytes, zip bundling, signed URLs, raw file
//   documents.versions.ts  — version lifecycle (list/create/rename/delete)
//   documents.edits.ts     — tracked-change ids + accept/reject edits
//
// Upload sessions own transport and destination authorization; version metadata
// creation, activation, replacement, copying, and cleanup use this facade.

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
    getFileStreamSource,
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

export { renameDocument } from "./documents.rename";
export { deleteCollectionDocuments } from "./documents.cleanup";

export { handleDocumentPrecomputeText } from "./documents.textJobs";
export { handleConversionConvert, markConversionFailed } from "./documents.conversionJobs";
export { sweepStaleProcessingDocuments } from "./documents.maintenance";

export { createDocumentVersion, type NewDocumentVersion, type DocumentVersionRecord } from "./documents.lifecycle";
export { handleDocumentCleanup } from "./documents.cleanupJobs";
export { copyDocumentVersionFiles } from "./documents.copyFiles";
export { captureInlineDocumentCleanup, completeInlineDocumentCleanup } from "./documents.cleanupJobs";
export { createDocumentVersions, activateDocumentVersion, updateDocumentVersion, type DocumentVersionPatch } from "./documents.lifecycle";

export { runConversionJob, setDocumentTerminalStatus } from "./documents.conversion";

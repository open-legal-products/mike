// The uploads module's stable facade.
//
// The upload protocol has one caller outside this directory besides app.ts
// (which mounts uploads.routes.ts at /upload-sessions): workerRuntime.ts,
// which starts the background processors. It comes through this file, so the
// module's internal decomposition can change without touching it.
//
//   uploads.manifest.ts   — request vocabulary, limits, and the one validator
//   uploads.shared.ts     — row shapes, the public file projection, failures
//   uploads.access.ts     — destination authorization
//   uploads.sessions.ts   — session lifecycle: create, sign, seal, cancel
//   uploads.processing.ts — the worker that turns sealed bytes into documents
//   uploads.routes.ts     — the HTTP layer over the above (imports its
//                           siblings directly, like every other module)

export { startUploadProcessingWorkers } from "./uploads.processing";

export {
  parseUploadSessionRequest,
  uploadSessionExpiresAt,
  UploadSessionValidationError,
} from "./uploads.manifest";
export type {
  ParsedUploadSessionRequest,
  UploadSessionFile,
} from "./uploads.manifest";

export { validateDestinationAccess } from "./uploads.access";

export {
  cancelUploadSession,
  completeUploadSessionFile,
  createUploadSession,
  getUploadSession,
  refreshUploadUrls,
} from "./uploads.sessions";

export type {
  UploadFailure,
  UploadOutcome,
  UploadResult,
} from "./uploads.shared";

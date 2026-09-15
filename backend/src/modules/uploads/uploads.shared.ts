// Shared vocabulary for the uploads module's service files: the two row
// shapes the control plane reads, the public projection of a file row, and
// the failure type services return instead of writing to `res`.
//
// The upload protocol answers with statuses the generic service-result kinds
// do not cover (410 for an expired session, 429 for a session-creation
// ceiling, a 409 body that carries the whole session), so a failure here
// names its status and body outright. uploads.routes.ts is the only place
// that turns one into an HTTP response.

import type { UploadSessionFile } from "./uploads.manifest";

export type UploadSessionRow = {
  id: string;
  user_id: string;
  user_email: string | null;
  purpose: string;
  destination: Record<string, unknown>;
  expected_file_count: number;
  expected_total_bytes: number;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type UploadSessionFileRow = UploadSessionFile & {
  session_id: string;
  observed_size_bytes: number | null;
  etag: string | null;
  status: string;
  error_code: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
};

export type UploadFailure =
  /** An intentional 4xx/410 answer: the body is sent verbatim. */
  | { ok: false; kind: "http"; status: number; body: Record<string, unknown> }
  /** An unexpected failure: the route logs it and sends the opaque body. */
  | { ok: false; kind: "internal"; status?: number; error: unknown };

export type UploadResult<T> = { ok: true; data: T } | UploadFailure;

/** Outcome of a guard that has nothing to return but success. */
export type UploadOutcome = { ok: true } | UploadFailure;

export function failure(
  status: number,
  body: Record<string, unknown>,
): UploadFailure {
  return { ok: false, kind: "http", status, body };
}

export function internalFailure(
  error: unknown,
  status?: number,
): UploadFailure {
  return { ok: false, kind: "internal", status, error };
}

/**
 * The client-visible shape of an upload file. Storage paths and the session
 * id stay server-side; a manifest entry that has no row yet reports the
 * defaults a freshly created file would have.
 */
export function publicFile(file: UploadSessionFileRow | UploadSessionFile) {
  return {
    id: file.id,
    resource_id: file.resource_id,
    client_id: file.client_id,
    filename: file.filename,
    target_folder_id: file.target_folder_id,
    file_type: file.file_type,
    content_type: file.content_type,
    expected_size_bytes: file.expected_size_bytes,
    observed_size_bytes:
      "observed_size_bytes" in file ? file.observed_size_bytes : null,
    status: "status" in file ? file.status : "pending_upload",
    error_code: "error_code" in file ? file.error_code : null,
    result: "result" in file ? file.result : null,
  };
}

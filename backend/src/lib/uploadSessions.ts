import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  ALLOWED_DOCUMENT_TYPES,
  ALLOWED_DOCUMENT_TYPES_LABEL,
  contentTypeForDocumentType,
} from "./documentTypes";
export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_SESSION_FILES = 50;
export const MAX_UPLOAD_SESSION_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_SESSION_TTL_SECONDS = 30 * 60;
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const UPLOAD_VERIFICATION_LEASE_SECONDS = 5 * 60;

const clientFileSchema = z
  .object({
    client_id: z.string().trim().min(1).max(128),
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (filename) => !/[\x00-\x1F\x7F/\\]/.test(filename),
        "filename is invalid",
      ),
    size_bytes: z.number().int().positive().max(MAX_UPLOAD_SIZE_BYTES),
    folder_id: z.string().uuid().nullable().optional(),
  })
  .strict();

const documentDestinationSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("standalone") }).strict(),
  z
    .object({
      scope: z.literal("project"),
      project_id: z.string().uuid(),
      folder_id: z.string().uuid().nullable().optional(),
    })
    .strict(),
  z
    .object({
      scope: z.literal("library"),
      library_kind: z.enum(["file", "template"]),
      folder_id: z.string().uuid().nullable().optional(),
    })
    .strict(),
]);

const requestSchema = z.discriminatedUnion("purpose", [
  z
    .object({
      purpose: z.literal("document_create"),
      destination: documentDestinationSchema,
      files: z.array(clientFileSchema).min(1).max(MAX_UPLOAD_SESSION_FILES),
    })
    .strict(),
  z
    .object({
      purpose: z.literal("document_version_create"),
      destination: z
        .object({
          document_id: z.string().uuid(),
          filename: z.string().trim().min(1).max(200).optional(),
        })
        .strict(),
      files: z.tuple([clientFileSchema]),
    })
    .strict(),
  z
    .object({
      purpose: z.literal("document_version_replace"),
      destination: z
        .object({
          document_id: z.string().uuid(),
          version_id: z.string().uuid(),
        })
        .strict(),
      files: z.tuple([clientFileSchema]),
    })
    .strict(),
  z
    .object({
      purpose: z.literal("workflow_reference_create"),
      destination: z.object({ workflow_id: z.string().uuid() }).strict(),
      files: z.array(clientFileSchema).min(1).max(MAX_UPLOAD_SESSION_FILES),
    })
    .strict(),
  z
    .object({
      purpose: z.literal("workflow_reference_replace"),
      destination: z
        .object({
          workflow_id: z.string().uuid(),
          reference_id: z.string().uuid(),
        })
        .strict(),
      files: z.tuple([clientFileSchema]),
    })
    .strict(),
]);

export type UploadSessionRequest = z.infer<typeof requestSchema>;

export type UploadSessionFile = {
  id: string;
  resource_id: string;
  client_id: string;
  filename: string;
  target_folder_id: string | null;
  file_type: string;
  content_type: string;
  expected_size_bytes: number;
  staging_storage_path: string;
  sealed_storage_path: string;
};

export type ParsedUploadSessionRequest = {
  purpose: UploadSessionRequest["purpose"];
  destination: UploadSessionRequest["destination"];
  expected_total_bytes: number;
  files: UploadSessionFile[];
};

export class UploadSessionValidationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    options: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "UploadSessionValidationError";
    this.status = options.status ?? 400;
    this.code = options.code ?? "invalid_upload_session";
  }
}

function fileTypeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function parseUploadSessionRequest(
  value: unknown,
  userId: string,
  sessionId = randomUUID(),
): ParsedUploadSessionRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const isFileTooLarge =
      issue?.code === "too_big" && issue.path.includes("size_bytes");
    throw new UploadSessionValidationError(
      isFileTooLarge
        ? "Each uploaded file must be 100 MB or smaller"
        : (issue?.message ?? "Invalid upload session request"),
      isFileTooLarge
        ? { status: 413, code: "upload_file_too_large" }
        : undefined,
    );
  }

  const seenClientIds = new Set<string>();
  let expectedTotalBytes = 0;
  const files = parsed.data.files.map((file) => {
    if (seenClientIds.has(file.client_id)) {
      throw new UploadSessionValidationError("client_id values must be unique");
    }
    seenClientIds.add(file.client_id);

    if (
      parsed.data.purpose !== "document_create" &&
      file.folder_id !== undefined
    ) {
      throw new UploadSessionValidationError(
        "folder_id is only valid when creating documents",
      );
    }
    if (
      parsed.data.purpose === "document_create" &&
      parsed.data.destination.scope === "standalone" &&
      file.folder_id
    ) {
      throw new UploadSessionValidationError(
        "folder_id is not valid for standalone documents",
      );
    }

    const fileType = fileTypeFromFilename(file.filename);
    if (!ALLOWED_DOCUMENT_TYPES.has(fileType)) {
      throw new UploadSessionValidationError(
        `Unsupported file type: ${fileType || "unknown"}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
      );
    }

    expectedTotalBytes += file.size_bytes;
    if (expectedTotalBytes > MAX_UPLOAD_SESSION_TOTAL_BYTES) {
      throw new UploadSessionValidationError(
        "Upload batch exceeds the 2 GB total size limit",
        { status: 413, code: "upload_batch_too_large" },
      );
    }

    const id = randomUUID();
    const resourceId = randomUUID();
    const basePath = `upload-sessions/${userId}/${sessionId}/${id}`;
    return {
      id,
      resource_id: resourceId,
      client_id: file.client_id,
      filename: file.filename,
      target_folder_id: file.folder_id ?? null,
      file_type: fileType,
      content_type: contentTypeForDocumentType(fileType),
      expected_size_bytes: file.size_bytes,
      staging_storage_path: `${basePath}/staging`,
      sealed_storage_path: `${basePath}/sealed`,
    };
  });

  return {
    purpose: parsed.data.purpose,
    destination: parsed.data.destination,
    expected_total_bytes: expectedTotalBytes,
    files,
  };
}

export function uploadSessionExpiresAt(now = new Date()): string {
  return new Date(
    now.getTime() + UPLOAD_SESSION_TTL_SECONDS * 1000,
  ).toISOString();
}

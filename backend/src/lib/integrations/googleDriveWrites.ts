import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  googleDriveHttpError,
  googleDriveRequest,
  GoogleDriveUserError,
} from "./googleDriveHttp";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
const FIELDS =
  "id,name,mimeType,description,parents,trashed,version,webViewLink";
const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .max(256);
const name = z.string().trim().min(1).max(255);
const content = z.string().max(60_000);
const parent = { parent_id: id.optional() };
const file = { file_id: id };

export const DRIVE_WRITE_TOOLS = [
  {
    name: "google_drive_create_file",
    title: "Create file",
    description:
      "Create a UTF-8 text file or a Google Doc from plain text. Choose file_type text or google_doc. Optionally choose a parent folder; otherwise creates in My Drive.",
    schema: z.strictObject({
      name,
      content,
      file_type: z.enum(["text", "google_doc"]),
      ...parent,
    }),
  },
  {
    name: "google_drive_create_folder",
    title: "Create folder",
    description:
      "Create a folder in Google Drive, optionally inside a parent folder.",
    schema: z.strictObject({ name, ...parent }),
  },
  {
    name: "google_drive_update_file",
    title: "Rename or describe file",
    description:
      "Rename a Google Drive file or folder and/or update its description. Does not change its contents or sharing permissions.",
    schema: z
      .strictObject({
        ...file,
        name: name.optional(),
        description: z.string().max(5_000).optional(),
      })
      .refine((a) => a.name !== undefined || a.description !== undefined),
  },
  {
    name: "google_drive_replace_file_content",
    title: "Replace file contents",
    description:
      "Replace ALL contents of a plain-text file or Google Doc with the supplied plain text. Read the complete file first and preserve text the user did not ask to change. Google Doc formatting is replaced. Does not support PDF, Word, Sheets, Slides, or binary files. Use only when the user intends full content replacement.",
    schema: z.strictObject({ ...file, content }),
  },
  {
    name: "google_drive_move_file",
    title: "Move file",
    description:
      "Move a file or folder into a destination folder, removing its current parent. May change inherited access; review the destination.",
    schema: z.strictObject({ ...file, parent_id: id }),
  },
  {
    name: "google_drive_copy_file",
    title: "Copy file",
    description:
      "Copy a Google Drive file with a new name, optionally into a destination folder. Does not copy folders.",
    schema: z.strictObject({ ...file, name, ...parent }),
  },
  {
    name: "google_drive_trash_file",
    title: "Move to Trash",
    description:
      "Move a Google Drive file or folder to Trash. A trashed folder affects its contents. This does not permanently delete it; Google may automatically delete trashed files after its retention period.",
    schema: z.strictObject(file),
  },
  {
    name: "google_drive_restore_file",
    title: "Restore from Trash",
    description: "Restore a Google Drive file or folder from Trash.",
    schema: z.strictObject(file),
  },
];

export function driveWriteTool(name: string) {
  return DRIVE_WRITE_TOOLS.find((tool) => tool.name === name);
}

type FileSnapshot = {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  parents?: string[];
  trashed?: boolean;
  [key: string]: unknown;
};
export type DriveWriteSnapshot = {
  file?: FileSnapshot;
  destination?: FileSnapshot;
};
export type DriveWriteAction = {
  name: string;
  args: Record<string, unknown>;
  before: DriveWriteSnapshot;
  etag?: string;
};

class DriveWriteHttpError extends GoogleDriveUserError {
  constructor(public status: number) {
    super(
      status === 412
        ? "This Drive file changed after it was reviewed. Read it again and review a new action."
        : googleDriveHttpError(status).message,
    );
  }
}

export function parseDriveWrite(name: string, input: unknown) {
  const tool = driveWriteTool(name);
  const parsed = tool?.schema.safeParse(input);
  if (!tool || !parsed?.success)
    throw new GoogleDriveUserError("Invalid Google Drive action details.");
  return { tool, args: parsed.data as Record<string, unknown> };
}

async function metadata(token: string, fileId: string) {
  const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleDriveRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new DriveWriteHttpError(response.status);
  const file = (await response.json()) as FileSnapshot;
  if (!file.id || !file.version || !file.mimeType)
    throw new GoogleDriveUserError(
      "Google Drive could not verify this file. Try reading it again.",
    );
  return { file, etag: response.headers.get("etag") ?? undefined };
}

/** Read the exact source and destination that the approval card will describe. */
export async function prepareDriveWrite(
  name: string,
  input: unknown,
  token: string,
): Promise<DriveWriteAction> {
  const { args } = parseDriveWrite(name, input);
  const before: DriveWriteSnapshot = {};
  let etag: string | undefined;
  if (typeof args.file_id === "string") {
    const current = await metadata(token, args.file_id);
    before.file = current.file;
    etag = current.etag;
    if (current.file.trashed && name !== "google_drive_restore_file")
      throw new GoogleDriveUserError(
        "This Drive file is in Trash. Restore it before changing it.",
      );
    if (name === "google_drive_copy_file" && current.file.mimeType === FOLDER)
      throw new GoogleDriveUserError(
        "Google Drive cannot copy a folder with this tool.",
      );
    if (
      name === "google_drive_replace_file_content" &&
      !["text/plain", DOC].includes(current.file.mimeType)
    )
      throw new GoogleDriveUserError(
        "Content replacement supports plain-text files and Google Docs only. Other file types must be edited in their own application.",
      );
  }
  if (typeof args.parent_id === "string") {
    const destination = (await metadata(token, args.parent_id)).file;
    if (destination.mimeType !== FOLDER || destination.trashed)
      throw new GoogleDriveUserError(
        "Choose an available Google Drive folder as the destination.",
      );
    if (before.file?.id === destination.id)
      throw new GoogleDriveUserError("A folder cannot be moved into itself.");
    before.destination = destination;
  }
  return { name, args, before, etag };
}

/** Recheck reviewed versions before writing. If Google supplies an ETag, also
 * use its HTTP precondition to cover edits between the check and the write. */
export async function executeDriveWrite(
  action: DriveWriteAction,
  token: string,
  beforeWrite: () => Promise<void>,
) {
  const current = await prepareDriveWrite(action.name, action.args, token);
  for (const key of ["file", "destination"] as const) {
    const reviewed = action.before[key];
    const latest = current.before[key];
    if (
      reviewed &&
      (!latest ||
        latest.id !== reviewed.id ||
        latest.version !== reviewed.version)
    )
      throw new GoogleDriveUserError(
        "This Drive file or destination changed after it was reviewed. Read it again and review a new action.",
      );
  }
  const { name, args, before } = current;
  const filePath = `/files/${encodeURIComponent(String(args.file_id))}`;
  let path = filePath;
  let method = "PATCH";
  let body: Record<string, unknown> = {};
  let upload = false;
  const params: Record<string, string> = {
    fields: FIELDS,
    supportsAllDrives: "true",
  };
  const parents = before.destination ? [before.destination.id] : undefined;
  switch (name) {
    case "google_drive_create_file":
      path = "/files";
      method = "POST";
      body = {
        name: args.name,
        mimeType: args.file_type === "google_doc" ? DOC : "text/plain",
        ...(parents ? { parents } : {}),
      };
      upload = true;
      break;
    case "google_drive_create_folder":
      path = "/files";
      method = "POST";
      body = {
        name: args.name,
        mimeType: FOLDER,
        ...(parents ? { parents } : {}),
      };
      break;
    case "google_drive_update_file":
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      break;
    case "google_drive_replace_file_content":
      body = { mimeType: before.file!.mimeType };
      upload = true;
      break;
    case "google_drive_move_file":
      if (
        before.file?.parents?.length === 1 &&
        before.file.parents[0] === parents![0]
      )
        return before.file;
      params.addParents = parents![0];
      if (before.file?.parents?.length)
        params.removeParents = before.file.parents.join(",");
      break;
    case "google_drive_copy_file":
      path += "/copy";
      method = "POST";
      body = { name: args.name, ...(parents ? { parents } : {}) };
      break;
    case "google_drive_trash_file":
      body = { trashed: true };
      break;
    case "google_drive_restore_file":
      body = { trashed: false };
      break;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (action.etag && method === "PATCH") headers["If-Match"] = action.etag;
  let payload = JSON.stringify(body);
  if (upload) {
    const boundary = `mike_${randomUUID()}`;
    headers["Content-Type"] = `multipart/related; boundary=${boundary}`;
    params.uploadType = "multipart";
    payload = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${payload}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${args.content}\r\n--${boundary}--\r\n`;
  }
  const url = new URL(`${upload ? UPLOAD_API : API}${path}`);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  await beforeWrite();
  try {
    const response = await googleDriveRequest(url, {
      method,
      headers,
      body: payload,
    });
    if (!response.ok) throw new DriveWriteHttpError(response.status);
    return await response.json();
  } catch (error) {
    if (
      error instanceof DriveWriteHttpError &&
      error.status >= 400 &&
      error.status < 500
    )
      throw error;
    // A timeout, server error or unreadable success response may follow a
    // completed write. Never repeat the mutation automatically.
    throw new GoogleDriveUserError(
      "The outcome is uncertain. Check Google Drive before trying again; Mike will not retry this action.",
    );
  }
}

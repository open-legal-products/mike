/// <reference types="office-js" />
/**
 * Outlook's counterpart of the Word document helpers: the "active document"
 * is the message being composed.
 *
 * - Identity: a UUID stored as a custom property of the draft, the analogue
 *   of the Word document setting, so reopening the draft reopens its chats.
 * - Context: subject, recipients, the body (in a reply it carries the quoted
 *   thread) and the attachment list, rendered as plain markdown-ish text for
 *   the same document_context / read_active_document channel Word uses.
 * - Attachments: read with getAttachmentContentAsync and turned into File
 *   objects, so they are uploaded through the very same upload session and
 *   chip UI as files picked from the desktop.
 * - Insert: put a text card's draft into the body at the cursor or on top.
 *
 * Requires Mailbox 1.8 (compose attachment content).
 */
import { createSecureUuid } from "./secureUuid";

const OUTLOOK_DOCUMENT_ID_PROPERTY = "mike.outlook.documentId.v1";
const MAX_RECIPIENTS = 100;

type MailItem = Office.MessageCompose;

function composeItem(): MailItem {
  const item = Office.context.mailbox?.item as MailItem | undefined;
  if (!item) throw new Error("No message is open for writing.");
  return item;
}

function call<T>(fn: (cb: (result: Office.AsyncResult<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) resolve(result.value);
      else reject(new Error(result.error?.message || "Outlook could not complete the request."));
    });
  });
}

let lastSubject = "";

/** The draft's subject as last read, for chat titles and history rows. */
export function currentOutlookSubject(): string {
  return lastSubject.trim() || "Email";
}

export async function getOrCreateOutlookDocumentId(): Promise<string> {
  const item = composeItem();
  const props = await call<Office.CustomProperties>((cb) => item.loadCustomPropertiesAsync(cb));
  const existing = props.get(OUTLOOK_DOCUMENT_ID_PROPERTY);
  try {
    lastSubject = await call<string>((cb) => item.subject.getAsync(cb));
  } catch {
    // The subject only labels history; the identity does not depend on it.
  }
  if (typeof existing === "string" && existing.trim()) return existing;
  const documentId = createSecureUuid();
  props.set(OUTLOOK_DOCUMENT_ID_PROPERTY, documentId);
  await call<void>((cb) => props.saveAsync(cb));
  return documentId;
}

function formatRecipients(values: Office.EmailAddressDetails[] | undefined): string {
  return (values ?? [])
    .slice(0, MAX_RECIPIENTS)
    .map((r) => (r.displayName && r.displayName !== r.emailAddress ? `${r.displayName} <${r.emailAddress}>` : r.emailAddress))
    .join(", ");
}

async function listFileAttachments(item: MailItem): Promise<Office.AttachmentDetailsCompose[]> {
  const attachments = await call<Office.AttachmentDetailsCompose[]>((cb) => item.getAttachmentsAsync(cb));
  return attachments.filter((a) => !a.isInline);
}

/** The compose form as the text the model reads (snapshot and live read). */
export async function readComposeMarkdown(): Promise<string> {
  const item = composeItem();
  const [subject, to, cc, body, attachments] = await Promise.all([
    call<string>((cb) => item.subject.getAsync(cb)),
    call<Office.EmailAddressDetails[]>((cb) => item.to.getAsync(cb)),
    call<Office.EmailAddressDetails[]>((cb) => item.cc.getAsync(cb)),
    call<string>((cb) => item.body.getAsync(Office.CoercionType.Text, cb)),
    listFileAttachments(item).catch(() => [] as Office.AttachmentDetailsCompose[]),
  ]);
  lastSubject = subject;
  const lines = [
    `# Email being composed`,
    `Subject: ${subject || "(empty)"}`,
    `To: ${formatRecipients(to) || "(none)"}`,
  ];
  const ccLine = formatRecipients(cc);
  if (ccLine) lines.push(`Cc: ${ccLine}`);
  if (attachments.length) {
    lines.push(`Attachments: ${attachments.map((a) => a.name).join("; ")}`);
  }
  lines.push("", "## Body (draft and quoted thread)", "", body.trim() || "(empty)");
  return lines.join("\n");
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// AttachmentDetailsCompose has no content type, so infer it from the file
// name; the upload pipeline still validates the actual bytes.
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

export function mimeTypeForName(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export type EmailAttachmentRead = {
  files: File[];
  /** Cloud links and attached items that cannot be uploaded as files. */
  skipped: string[];
};

/** The message's file attachments as Files for the normal upload flow. */
export async function readComposeAttachmentFiles(): Promise<EmailAttachmentRead> {
  const item = composeItem();
  const attachments = await listFileAttachments(item);
  const files: File[] = [];
  const skipped: string[] = [];
  for (const attachment of attachments) {
    if (attachment.attachmentType !== Office.MailboxEnums.AttachmentType.File) {
      skipped.push(attachment.name);
      continue;
    }
    const content = await call<Office.AttachmentContent>((cb) =>
      item.getAttachmentContentAsync(attachment.id, cb),
    );
    if (content.format !== Office.MailboxEnums.AttachmentContentFormat.Base64) {
      skipped.push(attachment.name);
      continue;
    }
    const bytes = base64ToBytes(content.content);
    files.push(
      new File([bytes], attachment.name, {
        type: mimeTypeForName(attachment.name),
      }),
    );
  }
  return { files, skipped };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function draftToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export type EmailInsertPosition = "cursor" | "top";

/** Insert a draft into the body; nothing is ever sent. */
export async function insertIntoEmail(text: string, position: EmailInsertPosition): Promise<void> {
  const item = composeItem();
  const type = await call<Office.CoercionType>((cb) => item.body.getTypeAsync(cb));
  const html = type === Office.CoercionType.Html;
  const data = html ? draftToHtml(text) : text.trim();
  const options = { coercionType: html ? Office.CoercionType.Html : Office.CoercionType.Text };
  await call<void>((cb) =>
    position === "top"
      ? item.body.prependAsync(data, options, cb)
      : item.body.setSelectedDataAsync(data, options, cb),
  );
}

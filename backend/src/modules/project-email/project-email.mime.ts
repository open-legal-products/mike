import { createHash, randomUUID } from "node:crypto";
import { convert } from "html-to-text";
import { contentTypeForDocumentType, documentSuffix } from "../../lib/documentTypes";

// Deliberately smaller than interactive uploads: full Gmail JSON is bounded
// by the existing 8 MiB Google transport before it reaches this parser.
export const EMAIL_LIMITS = { messages: 5, parts: 40, depth: 10, fileBytes: 5 * 1024 * 1024, bodyBytes: 60_000, totalBytes: 20 * 1024 * 1024 };
export class EmailInputError extends Error {}
type Part = { partId?: string; mimeType?: string; filename?: string; headers?: Array<{ name: string; value: string }>; body?: { size?: number; data?: string; attachmentId?: string }; parts?: Part[] };
export type EmailPart = { key: string; attachmentId?: string; filename: string; mime: string; size: number; data?: string; excluded?: string };
export type EmailManifest = { id: string; threadId: string; subject: string; from: string; to: string; cc: string; replyTo: string; date: string; fingerprint: string; text: string; parts: EmailPart[]; bodyUnavailable?: string; sourceBytes?: number };
export function digest(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
export function providerId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,1024}$/.test(value)) throw new EmailInputError("Invalid Gmail identifier.");
  return value;
}
export function decodeEmailData(value: string, limit: number): Buffer {
  if (value.length > Math.ceil(limit * 4 / 3) + 4 || !/^[A-Za-z0-9_-]*={0,2}$/.test(value) || value.replace(/=+$/, "").length % 4 === 1) throw new EmailInputError("Invalid or oversized email data.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > limit || bytes.toString("base64url") !== value.replace(/=+$/, "")) throw new EmailInputError("Invalid or oversized email data.");
  return bytes;
}
// Display-only names never become storage paths. Reject rather than disguise
// traversal/control characters, and do not infer a trusted MIME from a name.
function safeAttachmentName(name: string): boolean {
  return !!name && name.length <= 200 && !/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069\ufffe\uffff]|\p{Surrogate}/u.test(name) && name !== "." && name !== "..";
}
function attachmentExclusion(name: string, mime: string, size: number): string | undefined {
  if (!safeAttachmentName(name)) return "Unsafe filename; not imported.";
  if (!Number.isSafeInteger(size) || size < 0) return "Attachment size metadata is invalid; not imported.";
  if (size > EMAIL_LIMITS.fileBytes) return "Attachment exceeds the import limit.";
  // A focused initial slice: PDF and DOCX. Other attachments remain visible
  // in the receipt instead of disappearing from the processing checkpoint.
  const suffix = documentSuffix(name);
  if (!["pdf", "docx"].includes(suffix) || contentTypeForDocumentType(suffix) !== mime) return "Unsupported attachment type; not imported.";
  return undefined;
}
// These are literal source destinations, never hyperlinks or fetch targets.
// Relative/active schemes have no meaningful safe destination in this rendering.
function sourceDestination(value: string | undefined): string | undefined {
  const destination = value?.trim();
  if (!destination || /[\s\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(destination)) return undefined;
  try {
    const url = new URL(destination);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname) return destination;
    if (url.protocol === "mailto:" && (url.pathname || url.search)) return destination;
  } catch { /* Unresolvable destinations remain label text only. */ }
  return undefined;
}
function renderHtml(text: string): string {
  const limitMarker = `[Email HTML structure exceeds the import limit ${randomUUID()}]`;
  const rendered = convert(text, {
    wordwrap: false,
    // Reject rather than silently accept the converter's partial rendering.
    limits: { maxInputLength: EMAIL_LIMITS.bodyBytes, maxDepth: 40, maxChildNodes: 4000, ellipsis: limitMarker },
    formatters: {
      sourceLink: (element, walk, builder) => {
        walk(element.children, builder);
        const destination = sourceDestination(element.attribs?.href);
        if (destination) builder.addInline(` [${destination}]`, { noWordTransform: true });
      },
    },
    selectors: [{ selector: "img", format: "skip" }, { selector: "script", format: "skip" }, { selector: "style", format: "skip" }, { selector: "a", format: "sourceLink" }],
  });
  // Heading formatters can uppercase the injected marker; source output stays unchanged.
  if (rendered.toLowerCase().includes(limitMarker.toLowerCase())) throw new EmailInputError("Email HTML exceeds the import structure limit.");
  return rendered;
}
// DOCX uses XML 1.0. Never silently erase source characters or write an
// invalid document; ordinary TAB/LF/CR and valid Unicode remain source text.
function checkedEmailText(value: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffe\uffff]|\p{Surrogate}/u.test(value)) {
    throw new EmailInputError("Email contains unsupported control characters; inspect the original message.");
  }
  return value;
}
const HEADER_UNAVAILABLE = "Display headers could not be read safely; inspect the original email.";
const BODY_UNAVAILABLE = "Email body could not be fully read within the supported text formats and limits; inspect the original email.";
const displayLabels = { subject: "Subject", from: "From", to: "To", cc: "Cc", replyTo: "Reply-To", date: "Date" } as const;
type DisplayHeaders = { [K in keyof typeof displayLabels]: string };

// Also protects receipts from malformed display metadata in older previews.
export function safeEmailDisplay(values: Partial<Record<keyof DisplayHeaders, unknown>>): DisplayHeaders & { bodyUnavailable?: string } {
  let bodyUnavailable: string | undefined;
  const read = (key: keyof DisplayHeaders): string => {
    try {
      const value = values[key] === undefined ? "" : values[key];
      if (typeof value !== "string") throw new EmailInputError(HEADER_UNAVAILABLE);
      // Validate the full source before bounding display; never split a Unicode pair.
      return checkedEmailText(value).slice(0, 2000).replace(/[\ud800-\udbff]$/, "");
    } catch (error) {
      if (!(error instanceof EmailInputError)) throw error;
      bodyUnavailable = HEADER_UNAVAILABLE;
      return `[${displayLabels[key]} unavailable]`;
    }
  };
  const headers = { subject: read("subject"), from: read("from"), to: read("to"), cc: read("cc"), replyTo: read("replyTo"), date: read("date") };
  return { ...headers, ...(bodyUnavailable ? { bodyUnavailable } : {}) };
}
function sourceHeaders(part: Part): Array<{ name: string; value: string }> {
  if (part.headers === undefined) return [];
  if (!Array.isArray(part.headers) || part.headers.some(h => !h || typeof h.name !== "string" || /[\x00-\x1f\x7f\ufffe\uffff]|\p{Surrogate}/u.test(h.name) || typeof h.value !== "string")) throw new EmailInputError(HEADER_UNAVAILABLE);
  return part.headers;
}
function sourceByteSize(body: NonNullable<Part["body"]>): number {
  const declared = Number.isSafeInteger(body.size) && body.size! >= 0 ? body.size! : 0;
  // Keep unreadable source charged to packet/page budgets after dropping text.
  const encoded = typeof body.data === "string" ? body.data : "";
  const bytes = /^[A-Za-z0-9_-]*={0,2}$/.test(encoded) ? Math.floor(encoded.replace(/=+$/, "").length * 3 / 4) : Buffer.byteLength(encoded);
  return Math.max(declared, bytes);
}
export function parseEmail(raw: Record<string, unknown>): EmailManifest {
  const id = providerId(raw.id), threadId = providerId(raw.threadId);
  const payload = raw.payload as Part | undefined;
  const mimeBodies = new WeakSet<object>();
  const identities = new Set<string>();
  let count = 0, sourceBytes = 0;
  // Complete structural validation before any recoverable text conversion.
  // Even skipped attachment descendants consume budgets and bind raw metadata.
  const register = (part: Part, depth: number): void => {
    if (!part || typeof part !== "object" || Array.isArray(part) || (part.parts !== undefined && !Array.isArray(part.parts))) throw new EmailInputError("Email MIME structure is unavailable.");
    if (++count > EMAIL_LIMITS.parts || depth > EMAIL_LIMITS.depth) throw new EmailInputError("Email has too many MIME parts.");
    if (part.partId !== undefined && part.partId !== "") {
      if (typeof part.partId !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(part.partId) || identities.has(part.partId)) throw new EmailInputError("Email MIME part identity is ambiguous.");
      identities.add(part.partId);
    }
    if (typeof part.mimeType !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(part.mimeType)) throw new EmailInputError("Email MIME structure is unavailable.");
    if (part.body !== undefined && (!part.body || typeof part.body !== "object" || Array.isArray(part.body))) throw new EmailInputError("Email MIME structure is unavailable.");
    if (part.body) {
      mimeBodies.add(part.body);
      sourceBytes += sourceByteSize(part.body);
      if (sourceBytes > EMAIL_LIMITS.totalBytes) throw new EmailInputError("Email source exceeds the total import limit.");
    }
    for (const child of part.parts ?? []) register(child, depth + 1);
  };
  if (!payload) throw new EmailInputError("Email content is unavailable.");
  register(payload, 0);
  let headers: ReturnType<typeof safeEmailDisplay>;
  try {
    const rawHeaders = sourceHeaders(payload);
    const header = (name: string) => rawHeaders.find(h => h.name.toLowerCase() === name)?.value ?? "";
    headers = safeEmailDisplay({ subject: header("subject"), from: header("from"), to: header("to"), cc: header("cc"), replyTo: header("reply-to"), date: header("date") });
  } catch (error) {
    if (!(error instanceof EmailInputError)) throw error;
    headers = { subject: "[Subject unavailable]", from: "[From unavailable]", to: "[To unavailable]", cc: "[Cc unavailable]", replyTo: "[Reply-To unavailable]", date: "[Date unavailable]", bodyUnavailable: HEADER_UNAVAILABLE };
  }
  let bodyUnavailable = headers.bodyUnavailable;
  const parts: EmailPart[] = [];
  let bodySize = 0;
  type Body = { text: string; hasPlain: boolean };
  const visit = (part: Part, path: string): Body => {
    const mime = part.mimeType!.toLowerCase(), name = typeof part.filename === "string" ? part.filename : "", body = part.body ?? {};
    if (mime === "multipart/encrypted" || mime === "application/pkcs7-mime") throw new EmailInputError("Encrypted email needs manual review.");
    if (name || part.filename !== undefined && typeof part.filename !== "string" || (!mime.startsWith("multipart/") && !["text/plain", "text/html"].includes(mime))) {
      const size = Number.isSafeInteger(body.size) && body.size! >= 0 ? body.size! : 0;
      let excluded = attachmentExclusion(name, mime, body.size === undefined ? 0 : body.size);
      const unsafeName = !safeAttachmentName(name);
      const filename = unsafeName ? `[Attachment name unavailable: ${path}]` : name;
      let attachmentId: string | undefined;
      if (body.attachmentId !== undefined) {
        try { attachmentId = providerId(body.attachmentId); }
        catch (error) { if (!(error instanceof EmailInputError)) throw error; excluded = "Attachment download identifier is invalid; not imported."; }
      }
      if (body.data !== undefined && typeof body.data !== "string") excluded = "Attachment content metadata is invalid; not imported.";
      if (body.data === undefined && attachmentId === undefined && !excluded) excluded = "Attachment content is unavailable; not imported.";
      parts.push({ key: path, filename, mime, size, ...(attachmentId ? { attachmentId } : {}), ...(typeof body.data === "string" && !excluded ? { data: body.data } : {}), excluded });
      return { text: "", hasPlain: false }; // Attached EMLs/archives are not recursively trusted.
    }
    const sections: Body[] = [];
    if (["text/plain", "text/html"].includes(mime)) {
      try {
        if (body.attachmentId !== undefined) throw new EmailInputError("Email body needs a separate download; inspect the original email.");
        if (body.data !== undefined && typeof body.data !== "string") throw new EmailInputError(BODY_UNAVAILABLE);
        const bytes = decodeEmailData(body.data ?? "", EMAIL_LIMITS.bodyBytes);
        if (body.size !== undefined && body.size !== bytes.length) throw new EmailInputError("Email body is incomplete; inspect the original email.");
        bodySize += bytes.length;
        if (bodySize > EMAIL_LIMITS.bodyBytes) throw new EmailInputError("Email body exceeds the text import limit; inspect the original email.");
        const charset = sourceHeaders(part).find(h => h.name.toLowerCase() === "content-type")?.value.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]?.toLowerCase();
        if (charset && !["utf-8", "us-ascii"].includes(charset)) throw new EmailInputError("Unsupported email character encoding; inspect the original email.");
        let decodedText: string;
        try { decodedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw new EmailInputError("Unsupported email character encoding; inspect the original email."); }
        // Check both stages: HTML entity decoding can introduce non-XML characters.
        const sourceText = checkedEmailText(decodedText);
        const renderedText = mime === "text/html" ? checkedEmailText(renderHtml(sourceText)) : sourceText;
        sections.push({ text: renderedText, hasPlain: mime === "text/plain" });
      } catch (error) {
        if (!(error instanceof EmailInputError)) throw error;
        bodyUnavailable ??= error.message; // Parser-authored reasons only, never source prose.
      }
    }
    sections.push(...(part.parts ?? []).map((child, i) => visit(child, `${path}.${i}`)));
    if (mime === "multipart/alternative") {
      // Alternatives describe one section; any failed alternative excludes the whole body.
      return sections.find(section => section.hasPlain && section.text.trim())
        ?? sections.find(section => section.text.trim())
        ?? { text: "", hasPlain: false };
    }
    return { text: sections.map(section => section.text).filter(Boolean).join("\n\n"), hasPlain: sections.some(section => section.hasPlain) };
  };
  const rendered = visit(payload, "0").text;
  if (Buffer.byteLength(rendered) > EMAIL_LIMITS.bodyBytes) bodyUnavailable ??= "Rendered email body exceeds the text import limit; inspect the original email.";
  // Bind the original raw payload, including malformed text. Opaque MIME-body
  // retrieval handles may rotate; similarly named non-body metadata stays bound.
  const fingerprint = digest(JSON.stringify(payload, function (this: object, key: string, value: unknown) {
    return key === "attachmentId" && mimeBodies.has(this) ? undefined : value;
  }));
  return { id, threadId, ...headers, text: bodyUnavailable ? "" : rendered, parts, fingerprint, sourceBytes, ...(bodyUnavailable ? { bodyUnavailable } : {}) };
}

export function verifyAttachment(bytes: Buffer, part: EmailPart) {
  if (part.excluded || bytes.length !== part.size || !bytes.length) throw new EmailInputError("Attachment bytes do not match the preview.");
  const suffix = documentSuffix(part.filename);
  if (suffix === "pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new EmailInputError("Attachment does not match its declared type.");
  if (suffix === "docx" && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new EmailInputError("Attachment does not match its declared type.");
}

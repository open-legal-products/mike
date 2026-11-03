import { createHash, randomUUID } from "node:crypto";
import { convert } from "html-to-text";
import { contentTypeForDocumentType, documentSuffix } from "../../lib/documentTypes";

// Deliberately smaller than interactive uploads: full Gmail JSON is bounded
// by the existing 8 MiB Google transport before it reaches this parser.
export const EMAIL_LIMITS = { messages: 5, parts: 40, depth: 10, fileBytes: 5 * 1024 * 1024, bodyBytes: 60_000, totalBytes: 20 * 1024 * 1024 };
export class EmailInputError extends Error {}
type Part = { partId?: string; mimeType?: string; filename?: string; headers?: Array<{ name: string; value: string }>; body?: { size?: number; data?: string; attachmentId?: string }; parts?: Part[] };
export type EmailPart = { key: string; attachmentId?: string; filename: string; mime: string; size: number; data?: string; excluded?: string };
export type EmailManifest = { id: string; threadId: string; subject: string; from: string; to: string; cc: string; replyTo: string; date: string; fingerprint: string; text: string; parts: EmailPart[] };
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
function attachmentExclusion(name: string, mime: string, size: number): string | undefined {
  if (!name || name.length > 200 || /[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/.test(name) || name === "." || name === "..") return "Unsafe filename; not imported.";
  if (!Number.isSafeInteger(size) || size < 0 || size > EMAIL_LIMITS.fileBytes) return "Attachment exceeds the import limit.";
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
export function parseEmail(raw: Record<string, unknown>): EmailManifest {
  const id = providerId(raw.id), threadId = providerId(raw.threadId);
  const payload = raw.payload as Part | undefined;
  if (!payload || typeof payload !== "object") throw new EmailInputError("Email content is unavailable.");
  const header = (name: string) => (payload.headers ?? []).find(h => h.name.toLowerCase() === name)?.value ?? "";
  // Keep the existing header bound without splitting a valid Unicode pair.
  const headerText = (value: string) => checkedEmailText(value).slice(0, 2000).replace(/[\ud800-\udbff]$/, "");
  const parts: EmailPart[] = [];
  const mimeBodies = new WeakSet<object>();
  let count = 0, bodySize = 0, declaredTotal = 0;
  type Body = { text: string; hasPlain: boolean };
  const registerPart = (part: Part, depth: number) => {
    if (++count > EMAIL_LIMITS.parts || depth > EMAIL_LIMITS.depth) throw new EmailInputError("Email has too many MIME parts.");
    if (part.body && typeof part.body === "object") mimeBodies.add(part.body);
  };
  const registerSkippedSubtree = (part: Part, depth: number): void => {
    registerPart(part, depth);
    for (const child of part.parts ?? []) registerSkippedSubtree(child, depth + 1);
  };
  const visit = (part: Part, path: string, depth: number): Body => {
    registerPart(part, depth);
    const mime = String(part.mimeType ?? "").toLowerCase(), name = String(part.filename ?? ""), body = part.body ?? {};
    if (mime === "multipart/encrypted" || mime === "application/pkcs7-mime") throw new EmailInputError("Encrypted email needs manual review.");
    if (name || (!mime.startsWith("multipart/") && !["text/plain", "text/html"].includes(mime))) {
      // Fingerprint their MIME bodies without decoding skipped attachments;
      // the same budgets bound this structural walk and ordinary rendering.
      for (const child of part.parts ?? []) registerSkippedSubtree(child, depth + 1);
      const size = body.size ?? 0;
      declaredTotal += Math.max(0, size);
      if (declaredTotal > EMAIL_LIMITS.totalBytes) throw new EmailInputError("Email attachments exceed the total limit.");
      parts.push({ key: path, filename: name || "unnamed", mime, size, ...(body.attachmentId ? { attachmentId: providerId(body.attachmentId) } : {}), ...(body.data !== undefined ? { data: body.data } : {}), excluded: attachmentExclusion(name, mime, size) });
      return { text: "", hasPlain: false }; // Attached EMLs/archives are not recursively trusted.
    }
    const sections: Body[] = [];
    if (["text/plain", "text/html"].includes(mime)) {
      if (body.attachmentId) throw new EmailInputError("Email body needs a separate download; import is incomplete.");
      const bytes = decodeEmailData(body.data ?? "", EMAIL_LIMITS.bodyBytes);
      if (body.size !== undefined && body.size !== bytes.length) throw new EmailInputError("Email body is incomplete.");
      bodySize += bytes.length;
      if (bodySize > EMAIL_LIMITS.bodyBytes) throw new EmailInputError("Email body exceeds the import limit.");
      const charset = (part.headers ?? []).find(h => h.name.toLowerCase() === "content-type")?.value.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]?.toLowerCase();
      if (charset && !["utf-8", "us-ascii"].includes(charset)) throw new EmailInputError("Unsupported email character encoding.");
      let decodedText: string;
      try { decodedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new EmailInputError("Unsupported email character encoding."); }
      // Check both stages: HTML entity decoding can introduce non-XML characters.
      const sourceText = checkedEmailText(decodedText);
      const renderedText = mime === "text/html" ? checkedEmailText(renderHtml(sourceText)) : sourceText;
      sections.push({ text: renderedText, hasPlain: mime === "text/plain" });
    }
    sections.push(...(part.parts ?? []).map((child, i) => visit(child, `${path}.${i}`, depth + 1)));
    if (mime === "multipart/alternative") {
      // Alternatives describe the same section. Choose only within this
      // group; a plain cover note must not suppress independent HTML terms
      // elsewhere in multipart/mixed (including other alternative groups).
      return sections.find(section => section.hasPlain && section.text.trim())
        ?? sections.find(section => section.text.trim())
        ?? { text: "", hasPlain: false };
    }
    return { text: sections.map(section => section.text).filter(Boolean).join("\n\n"), hasPlain: sections.some(section => section.hasPlain) };
  };
  const { text } = visit(payload, "0", 0);
  if (Buffer.byteLength(text) > EMAIL_LIMITS.bodyBytes) throw new EmailInputError("Rendered email body exceeds the import limit.");
  // Labels/history can change merely by reading elsewhere. Bind the actual
  // immutable message content, not those mutable mailbox attributes.
  // A body attachmentId is an opaque retrieval handle, not source content.
  // Omit only MIME-body locators, including skipped attachment descendants;
  // fresh download IDs stay in parts, and non-body metadata stays bound.
  const fingerprint = digest(JSON.stringify(payload, function (this: object, key: string, value: unknown) {
    return key === "attachmentId" && mimeBodies.has(this) ? undefined : value;
  }));
  return { id, threadId, subject: headerText(header("subject")), from: headerText(header("from")), to: headerText(header("to")), cc: headerText(header("cc")), replyTo: headerText(header("reply-to")), date: headerText(header("date")), text, parts, fingerprint };
}

export function verifyAttachment(bytes: Buffer, part: EmailPart) {
  if (part.excluded || bytes.length !== part.size || !bytes.length) throw new EmailInputError("Attachment bytes do not match the preview.");
  const suffix = documentSuffix(part.filename);
  if (suffix === "pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new EmailInputError("Attachment does not match its declared type.");
  if (suffix === "docx" && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new EmailInputError("Attachment does not match its declared type.");
}

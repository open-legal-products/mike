import { createHash } from "node:crypto";
import { convert } from "html-to-text";
import { contentTypeForDocumentType, documentSuffix } from "../../lib/documentTypes";

// Deliberately smaller than interactive uploads: full Gmail JSON is bounded
// by the existing 8 MiB Google transport before it reaches this parser.
export const EMAIL_LIMITS = { messages: 5, parts: 40, depth: 10, fileBytes: 5 * 1024 * 1024, bodyBytes: 60_000, totalBytes: 20 * 1024 * 1024 };
export class EmailInputError extends Error {}
type Part = { partId?: string; mimeType?: string; filename?: string; headers?: Array<{ name: string; value: string }>; body?: { size?: number; data?: string; attachmentId?: string }; parts?: Part[] };
export type EmailPart = { key: string; attachmentId?: string; filename: string; mime: string; size: number; data?: string; excluded?: string };
export type EmailManifest = { id: string; threadId: string; subject: string; from: string; to: string; date: string; fingerprint: string; text: string; parts: EmailPart[] };
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
export function parseEmail(raw: Record<string, unknown>): EmailManifest {
  const id = providerId(raw.id), threadId = providerId(raw.threadId);
  const payload = raw.payload as Part | undefined;
  if (!payload || typeof payload !== "object") throw new EmailInputError("Email content is unavailable.");
  const header = (name: string) => (payload.headers ?? []).find(h => h.name.toLowerCase() === name)?.value ?? "";
  const clean = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").slice(0, 2000);
  const parts: EmailPart[] = [];
  let count = 0, bodySize = 0, declaredTotal = 0;
  type Body = { text: string; hasPlain: boolean };
  const visit = (part: Part, path: string, depth: number): Body => {
    if (++count > EMAIL_LIMITS.parts || depth > EMAIL_LIMITS.depth) throw new EmailInputError("Email has too many MIME parts.");
    const mime = String(part.mimeType ?? "").toLowerCase(), name = String(part.filename ?? ""), body = part.body ?? {};
    if (mime === "multipart/encrypted" || mime === "application/pkcs7-mime") throw new EmailInputError("Encrypted email needs manual review.");
    if (name || (!mime.startsWith("multipart/") && !["text/plain", "text/html"].includes(mime))) {
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
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new EmailInputError("Unsupported email character encoding."); }
      sections.push({ text: mime === "text/plain" ? text : convert(text, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }, { selector: "a", options: { ignoreHref: true } }] }), hasPlain: mime === "text/plain" });
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
  // Labels/history can change merely by reading elsewhere. Bind the actual
  // immutable message content, not those mutable mailbox attributes.
  return { id, threadId, subject: clean(header("subject")), from: clean(header("from")), to: clean(header("to")), date: clean(header("date")), text, parts, fingerprint: digest(JSON.stringify(payload)) };
}

export function verifyAttachment(bytes: Buffer, part: EmailPart) {
  if (part.excluded || bytes.length !== part.size || !bytes.length) throw new EmailInputError("Attachment bytes do not match the preview.");
  const suffix = documentSuffix(part.filename);
  if (suffix === "pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new EmailInputError("Attachment does not match its declared type.");
  if (suffix === "docx" && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new EmailInputError("Attachment does not match its declared type.");
}

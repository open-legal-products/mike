import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { isAllocationFailure } from "./extraction/limits";

// Same 100 MiB upload ceiling; parser-only code must not import uploads.
const DOCX_MAX_BYTES = 100 * 1024 * 1024;
class InvalidDocxPackageError extends Error {}

const DOCX_MAIN_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const DOCX_CONTENT_TYPES_MAX_BYTES = 256 * 1024;
const docxXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  // Preserve namespace identity while retaining prior text/attribute trimming.
  tagValueProcessor: (_name, value) => value.trim(),
  attributeValueProcessor: (name, value) =>
    name === "xmlns" || name.startsWith("xmlns:") ? value : value.trim(),
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type XmlElement = Record<string, unknown>;

function parseDocxXml(xml: string): XmlElement {
  // Package XML must not define entities or depend on an external DTD.
  if (/<!DOCTYPE\b/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new InvalidDocxPackageError();
  }
  return docxXmlParser.parse(xml) as XmlElement;
}

function xmlChildren(
  parent: XmlElement,
  localName: string,
  namespace: string,
): XmlElement[] {
  return Object.entries(parent).flatMap(([name, values]) => {
    if (name.startsWith("@_") || name.startsWith("#")) return [];
    // XMLValidator accepts XML Names with extra colons, not just QNames.
    const parts = name.split(":");
    if (parts.length > 2 || parts.some((part) => !part)) {
      throw new InvalidDocxPackageError();
    }
    const [prefix, local] = parts.length === 2 ? parts : ["", name];
    if (local !== localName) return [];
    const namespaceAttribute = prefix ? `@_xmlns:${prefix}` : "@_xmlns";
    return (Array.isArray(values) ? values : [values]).flatMap((value) => {
      const element = value !== null && typeof value === "object"
        ? value as XmlElement
        : {};
      return (element[namespaceAttribute] ?? parent[namespaceAttribute]) === namespace
        ? [element]
        : [];
    });
  });
}

function hasDocxMainRelationship(xml: string): boolean {
  const parsed = parseDocxXml(xml);
  const namespace = "http://schemas.openxmlformats.org/package/2006/relationships";
  const roots = xmlChildren(parsed, "Relationships", namespace);
  if (Object.keys(parsed).length !== 1 || roots.length !== 1) return false;
  const root = roots[0]!;
  const relationships = xmlChildren(root, "Relationship", namespace).filter(
    (relationship) => [
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
      "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
    ].includes(String(relationship["@_Type"])),
  );
  if (relationships.length !== 1) return false;
  const relationship = relationships[0]!;
  if (
    relationship["@_TargetMode"] !== undefined &&
    relationship["@_TargetMode"] !== "Internal"
  ) return false;
  const target = relationship["@_Target"];
  if (
    typeof target !== "string" || !target ||
    target.startsWith("//") || /[\\:?#]/.test(target)
  ) return false;
  // Resolve a package-relative URI only; this never opens a URL.
  const resolved = new URL(target, "https://docx.invalid/");
  return resolved.origin === "https://docx.invalid" &&
    resolved.pathname === "/word/document.xml";
}

function hasDocxMainDocument(xml: string): boolean {
  const parsed = parseDocxXml(xml);
  if (Object.keys(parsed).length !== 1) return false;
  return [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
  ].some((namespace) => {
    const documents = xmlChildren(parsed, "document", namespace);
    return documents.length === 1 &&
      xmlChildren(documents[0]!, "body", namespace).length === 1;
  });
}

function zipEntryUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as JSZip.JSZipObject & {
    _data?: { uncompressedSize?: unknown };
  })._data;
  const size = data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

type BoundedZipEntryStream = {
  on(event: "data", listener: (chunk: Buffer) => void): BoundedZipEntryStream;
  on(event: "error", listener: (error: unknown) => void): BoundedZipEntryStream;
  on(event: "end", listener: () => void): BoundedZipEntryStream;
  pause(): void;
  resume(): void;
};

async function readZipEntryBounded(
  entry: JSZip.JSZipObject,
  maxBytes: number,
): Promise<string> {
  const declaredSize = zipEntryUncompressedSize(entry);
  if (
    declaredSize === null ||
    declaredSize < 0 ||
    declaredSize > maxBytes
  ) {
    throw new InvalidDocxPackageError();
  }

  const chunks: Buffer[] = [];
  let actualSize = 0;
  const stream = (entry as JSZip.JSZipObject & {
    internalStream(type: "nodebuffer"): BoundedZipEntryStream;
  }).internalStream("nodebuffer");

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    stream.on("data", (chunk) => {
      if (settled) return;
      actualSize += chunk.byteLength;
      if (actualSize > maxBytes) {
        settled = true;
        stream.pause();
        reject(new InvalidDocxPackageError());
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    stream.resume();
  });

  if (actualSize !== declaredSize) {
    throw new InvalidDocxPackageError();
  }
  const bytes = Buffer.concat(chunks, actualSize);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe
    ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff
      ? "utf-16be"
      : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function hasDocxMainDocumentOverride(contentTypes: string): boolean {
  const parsed = parseDocxXml(contentTypes);
  const namespace = "http://schemas.openxmlformats.org/package/2006/content-types";
  const roots = xmlChildren(parsed, "Types", namespace);
  if (Object.keys(parsed).length !== 1 || roots.length !== 1) return false;
  return xmlChildren(roots[0]!, "Override", namespace).some(
    (override) =>
      override["@_PartName"] === "/word/document.xml" &&
      override["@_ContentType"] === DOCX_MAIN_DOCUMENT_CONTENT_TYPE,
  );
}

/** Full-tree validation belongs in the existing parser process, not uploads.
 * Off-mode callers deliberately retain in-process behavior without containment.
 */
export async function validateDocxPackage(bytes: ArrayBuffer): Promise<boolean> {
  if (bytes.byteLength > DOCX_MAX_BYTES) return false;
  try {
    const zip = await JSZip.loadAsync(bytes);
    // Older Windows writers store "\" separators; accept them as "/" the way
    // normalizeDocxZipPaths (lib/convert.ts) does before conversion.
    const part = (name: string) => zip.file(name) ?? zip.file(name.replaceAll("/", "\\"));
    const contentTypesPart = part("[Content_Types].xml");
    const relationshipsPart = part("_rels/.rels");
    const documentPart = part("word/document.xml");

    if (!contentTypesPart || !relationshipsPart || !documentPart) {
      throw new InvalidDocxPackageError();
    }

    const contentTypes = await readZipEntryBounded(
      contentTypesPart,
      DOCX_CONTENT_TYPES_MAX_BYTES,
    );
    if (!hasDocxMainDocumentOverride(contentTypes)) {
      throw new InvalidDocxPackageError();
    }
    const relationships = await readZipEntryBounded(
      relationshipsPart,
      DOCX_CONTENT_TYPES_MAX_BYTES,
    );
    if (!hasDocxMainRelationship(relationships)) {
      throw new InvalidDocxPackageError();
    }
    // Main document XML can be much larger than package metadata. Reuse the
    // upload ceiling instead of imposing the small metadata limit on it.
    const document = await readZipEntryBounded(documentPart, DOCX_MAX_BYTES);
    if (!hasDocxMainDocument(document)) {
      throw new InvalidDocxPackageError();
    }
    return true;
  } catch (error) {
    // Do not turn allocation failures or unexpected parser bugs into a claim
    // that the document is malformed. The existing process classifies resources.
    if (isAllocationFailure(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const invalidEncoding = error instanceof TypeError &&
      (error as NodeJS.ErrnoException).code === "ERR_ENCODING_INVALID_ENCODED_DATA";
    // JSZip/pako report malformed or unsupported archives with ordinary errors.
    const invalidZip = /corrupted zip|end of data reached|can't find end of central directory|multi-volumes zip|encrypted zip|uncompressed data size mismatch|^invalid (?:block|stored|code|bit|literal|distance)|^incorrect (?:data|length)|^too many length/i.test(message);
    if (error instanceof InvalidDocxPackageError || invalidEncoding || invalidZip) return false;
    throw error;
  }
}

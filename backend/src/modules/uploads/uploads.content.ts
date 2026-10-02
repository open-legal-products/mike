// Content-based validation for uploaded documents. The browser's filename and
// Content-Type are claims; the bytes are the evidence. A file is accepted only
// when its leading bytes (and, for OOXML, its package layout) match the type
// it was declared as.
//
// The upload is already in object storage when this runs and can be 100 MB, so
// nothing here needs the whole object: every check reads byte ranges through a
// `ReadRange` callback. A PDF or legacy Office file needs its first bytes; an
// OOXML file is a ZIP, whose table of contents (the central directory) sits at
// the end, so it needs the tail plus the directory itself.

/** Reads the inclusive byte range [start, end] of the object being checked. */
export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

/** A PDF header must appear within the first 1024 bytes (ISO 32000). */
const HEAD_BYTES = 1024;

const OLE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

// The part every valid package of that type must contain, besides
// [Content_Types].xml.
const OOXML_MAIN_PART: Record<string, string> = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  xlsm: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
};

const LEGACY_OLE_TYPES = new Set(["doc", "xls", "ppt"]);

// ZIP structure (APPNOTE.txt). The end-of-central-directory record is 22 bytes
// plus a comment of up to 65535 bytes, so it lies within the last 65557.
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_ENTRY = 0x02014b50;
const ZIP_END_RECORD = 0x06054b50;
const ZIP_END_RECORD_MIN = 22;
const ZIP_TAIL_BYTES = ZIP_END_RECORD_MIN + 0xffff;
const ZIP_CENTRAL_ENTRY_MIN = 46;
// Office packages list a few dozen to a few thousand parts; a directory past
// this is not a document and is not worth reading into memory.
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;

export function hasPdfHeader(head: Uint8Array): boolean {
  return Buffer.from(head.subarray(0, HEAD_BYTES))
    .toString("latin1")
    .includes("%PDF-");
}

/**
 * The entry names listed in a ZIP's central directory, or null when the bytes
 * are not a ZIP this reader understands (including ZIP64, which no Office
 * document needs at the upload size limit). Nothing is decompressed.
 */
export async function readZipEntryNames(
  size: number,
  read: ReadRange,
): Promise<Set<string> | null> {
  if (size < ZIP_END_RECORD_MIN) return null;

  const head = Buffer.from(await read(0, Math.min(size, 4) - 1));
  if (head.length < 4 || head.readUInt32LE(0) !== ZIP_LOCAL_HEADER) return null;

  const tailStart = Math.max(0, size - ZIP_TAIL_BYTES);
  const tail = Buffer.from(await read(tailStart, size - 1));
  let end = -1;
  for (let i = tail.length - ZIP_END_RECORD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== ZIP_END_RECORD) continue;
    // The comment length must account for exactly the bytes that follow, so a
    // signature appearing inside a comment is not taken for the record.
    if (i + ZIP_END_RECORD_MIN + tail.readUInt16LE(i + 20) === tail.length) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  const entryCount = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directorySize > MAX_CENTRAL_DIRECTORY_BYTES ||
    directoryOffset + directorySize > size
  ) {
    return null;
  }

  const directory = Buffer.from(
    directorySize === 0
      ? new Uint8Array()
      : await read(directoryOffset, directoryOffset + directorySize - 1),
  );
  const names = new Set<string>();
  let pos = 0;
  for (let n = 0; n < entryCount; n++) {
    if (
      pos + ZIP_CENTRAL_ENTRY_MIN > directory.length ||
      directory.readUInt32LE(pos) !== ZIP_CENTRAL_ENTRY
    ) {
      return null;
    }
    const nameLength = directory.readUInt16LE(pos + 28);
    const extraLength = directory.readUInt16LE(pos + 30);
    const commentLength = directory.readUInt16LE(pos + 32);
    const nameEnd = pos + ZIP_CENTRAL_ENTRY_MIN + nameLength;
    if (nameEnd > directory.length) return null;
    names.add(directory.toString("utf8", pos + ZIP_CENTRAL_ENTRY_MIN, nameEnd));
    pos = nameEnd + extraLength + commentLength;
  }
  return names;
}

/**
 * True when the object plausibly is a document of `fileType`. Unknown types
 * are rejected. `read` may throw (storage failure); that is not a verdict on
 * the file and is left to the caller.
 */
export async function validateDocumentContent(
  fileType: string,
  size: number,
  read: ReadRange,
): Promise<boolean> {
  const type = fileType.toLowerCase();
  if (size <= 0) return false;

  if (type === "pdf") {
    return hasPdfHeader(await read(0, Math.min(size, HEAD_BYTES) - 1));
  }
  if (LEGACY_OLE_TYPES.has(type)) {
    const head = await read(0, Math.min(size, OLE_SIGNATURE.length) - 1);
    return Buffer.from(head).equals(OLE_SIGNATURE);
  }
  const mainPart = OOXML_MAIN_PART[type];
  if (!mainPart) return false;
  const names = await readZipEntryNames(size, read);
  return !!names && names.has("[Content_Types].xml") && names.has(mainPart);
}

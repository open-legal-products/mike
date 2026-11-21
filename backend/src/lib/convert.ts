import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AppError } from "./appError";
import { uploadConversionTimeoutMs } from "./runtimeConfig";

let _convert:
  ((buf: Buffer, ext: string, filter: undefined) => Promise<Buffer>) | null =
  null;
let _sofficeBinaryPaths: string[] | null = null;

// Server-log text for the operator (never sent to a client). The backend
// Docker image and backend/nixpacks.toml both install LibreOffice; any other
// host has to install it or point at its soffice binary.
const CONVERTER_UNAVAILABLE_MESSAGE =
  "LibreOffice (soffice) was not found, so Office documents cannot be " +
  "converted to PDF (uploads are kept without a PDF rendition; previews " +
  "and text extraction of legacy Office files fail). Install LibreOffice " +
  "(the backend Docker image and backend/nixpacks.toml include it) or set " +
  "SOFFICE_BINARY_PATH or LIBREOFFICE_BINARY_PATH to the soffice " +
  "executable, then restart the backend and worker.";

/** Keep legacy consumer codes derived from the more precise diagnostic kind. */
const CONVERSION_CODES = {
  "conversion.unavailable": "conversion_unavailable",
  "conversion.timeout": "conversion_timeout",
  "conversion.failed": "conversion_failed",
  "conversion.no_output": "conversion_failed",
} as const;
type ConversionKind = keyof typeof CONVERSION_CODES;

export class ConversionError extends AppError {
  readonly code: (typeof CONVERSION_CODES)[ConversionKind];

  constructor(kind: ConversionKind, message: string, options?: { cause?: unknown }) {
    super(kind, message, options);
    this.code = CONVERSION_CODES[kind];
  }
}

/**
 * No usable LibreOffice. Discovered up front (no binary passed the access
 * check) it carries the `conversion_unavailable` code; discovered by a spawn
 * that failed it carries no code of its own, so the attempt's errno (ENOENT,
 * EACCES) on the cause is what reaches `failure_code`, as it did when the
 * raw spawn error was thrown. Both name the kind.
 */
function converterUnavailable(cause?: unknown): AppError {
  if (cause !== undefined) {
    return new AppError(
      "conversion.unavailable",
      CONVERTER_UNAVAILABLE_MESSAGE,
      { cause },
    );
  }
  return new ConversionError(
    "conversion.unavailable",
    CONVERTER_UNAVAILABLE_MESSAGE,
  );
}

function executablePath(filePath: string) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSofficeBinaryPaths(): string[] {
  if (_sofficeBinaryPaths) return _sofficeBinaryPaths;

  const candidates = new Set<string>();
  for (const envName of [
    "SOFFICE_BINARY_PATH",
    "LIBREOFFICE_BINARY_PATH",
    "LIBRE_OFFICE_EXE",
  ]) {
    const value = process.env[envName]?.trim();
    if (value) candidates.add(value);
  }

  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of pathDirs) {
    candidates.add(path.join(dir, "soffice"));
    candidates.add(path.join(dir, "libreoffice"));
  }

  for (const filePath of [
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "/snap/bin/libreoffice",
    "/opt/libreoffice/program/soffice",
    "/opt/libreoffice7.6/program/soffice",
    // The official macOS installer keeps soffice inside the app bundle and
    // puts nothing on PATH, so a backend run outside Docker on a Mac would
    // otherwise report LibreOffice as missing while it is installed.
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ]) {
    candidates.add(filePath);
  }

  _sofficeBinaryPaths = [...candidates].filter(executablePath);
  return _sofficeBinaryPaths;
}

async function getConvert() {
  if (!_convert) {
    const libre = await import("libreoffice-convert");
    const convertWithOptions = libre.default.convertWithOptions.bind(
      libre.default,
    ) as (
      buf: Buffer,
      ext: string,
      filter: undefined,
      options: { sofficeBinaryPaths?: string[] },
      callback?: (err: Error | null, result: Buffer) => void,
    ) => Promise<Buffer> | void;
    _convert = (buf, ext, filter) =>
      new Promise<Buffer>((resolve, reject) => {
        try {
          const maybePromise = convertWithOptions(
            buf,
            ext,
            filter,
            { sofficeBinaryPaths: resolveSofficeBinaryPaths() },
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            },
          );
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then(resolve, reject);
          }
        } catch (err) {
          reject(err);
        }
      });
  }
  return _convert;
}

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_EOCD_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = 0xffff;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;

type ZipNameLocation = { central: number; local: number; length: number };

/**
 * Where each entry's name sits in the central directory and in its local
 * header, or null when the archive is not one this scan can read safely
 * (including ZIP64, which a DOCX within the upload limit has no need for).
 * Only headers are read; no entry's data is touched.
 */
function zipEntryNameLocations(buffer: Buffer): ZipNameLocation[] | null {
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - ZIP_EOCD_SIZE - ZIP_MAX_COMMENT_SIZE);
  for (let at = buffer.length - ZIP_EOCD_SIZE; at >= lowest; at--) {
    if (buffer.readUInt32LE(at) === ZIP_EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buffer.readUInt16LE(eocd + 10);
  const directoryStart = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryStart === 0xffffffff) return null;

  const locations: ZipNameLocation[] = [];
  let at = directoryStart;
  for (let index = 0; index < count; index++) {
    if (at + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(at) !== ZIP_CENTRAL_ENTRY_SIGNATURE) return null;
    const nameLength = buffer.readUInt16LE(at + 28);
    const name = at + 46;
    const next =
      name + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    if (next > buffer.length) return null;

    const local = buffer.readUInt32LE(at + 42);
    if (local === 0xffffffff || local + 30 + nameLength > buffer.length) return null;
    if (buffer.readUInt32LE(local) !== ZIP_LOCAL_HEADER_SIGNATURE) return null;
    // A local header that names the entry differently from the directory is
    // not something to patch blindly; leave the whole archive alone.
    if (buffer.readUInt16LE(local + 26) !== nameLength) return null;
    const localName = buffer.subarray(local + 30, local + 30 + nameLength);
    if (!localName.equals(buffer.subarray(name, name + nameLength))) return null;

    locations.push({ central: name, local: local + 30, length: nameLength });
    at = next;
  }
  return locations;
}

/**
 * Some older Windows/Word archives store .docx entries with backslash
 * separators (e.g. `word\document.xml`). Mammoth and LibreOffice both look
 * up entries by exact string and miss those files, producing empty output
 * or conversion failures. Rename any such entries to the canonical
 * forward-slash form before handing the buffer off.
 *
 * The rename edits the name bytes in the central directory and local
 * headers of a copy of the archive. `\` and `/` are one byte each, so no
 * offset moves, and no entry is decompressed or re-encoded: the work and the
 * memory are bounded by the upload's own size whatever the entries would
 * inflate to and whatever sizes their headers claim. (Inflating the entries
 * to rewrite them, as this used to, let a small upload expand to gigabytes
 * in the worker's heap.) An archive this scan cannot read, or whose
 * backslash name would collide with an existing entry, is left as it is,
 * exactly as an archive that needs no renaming.
 */
export async function normalizeDocxZipPaths(buffer: Buffer): Promise<Buffer> {
  if (buffer.length < ZIP_EOCD_SIZE) return buffer;
  const locations = zipEntryNameLocations(buffer);
  if (!locations) return buffer;

  const names = new Set(
    locations.map(({ central, length }) =>
      buffer.toString("latin1", central, central + length),
    ),
  );
  const renames = locations.filter(({ central, length }) => {
    const name = buffer.toString("latin1", central, central + length);
    if (!name.includes("\\")) return false;
    const renamed = name.replace(/\\/g, "/");
    if (names.has(renamed)) return false;
    names.add(renamed);
    return true;
  });
  if (renames.length === 0) return buffer;

  const patched = Buffer.from(buffer);
  for (const { central, local, length } of renames) {
    for (let offset = 0; offset < length; offset++) {
      if (patched[central + offset] === BACKSLASH) patched[central + offset] = SLASH;
      if (patched[local + offset] === BACKSLASH) patched[local + offset] = SLASH;
    }
  }
  return patched;
}

/**
 * Convert a DOCX/DOC buffer to PDF using LibreOffice.
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function docxToPdf(buffer: Buffer): Promise<Buffer> {
  if (resolveSofficeBinaryPaths().length === 0) {
    throw converterUnavailable();
  }
  const convert = await getConvert();
  const normalized = await normalizeDocxZipPaths(buffer);
  try {
    return await convert(normalized, ".pdf", undefined);
  } catch (error) {
    if (error instanceof AppError) throw error;
    // The library spawns soffice itself: a spawn failure is the converter
    // missing or unexecutable, the same condition officeFileToPdf names.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "EACCES") throw converterUnavailable(error);
    throw new ConversionError(
      "conversion.failed",
      "LibreOffice conversion failed",
      { cause: error },
    );
  }
}

/**
 * Convert an Office document from disk and leave the generated PDF on disk.
 * This is the upload-worker path: it avoids loading either the source file or
 * converted PDF into the Node.js process.
 */
export async function officeFileToPdf(
  inputPath: string,
  outputDirectory: string,
): Promise<string> {
  const binary = resolveSofficeBinaryPaths()[0];
  if (!binary) {
    throw converterUnavailable();
  }

  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const profileDirectory = path.join(outputDirectory, "libreoffice-profile");
  await fs.promises.mkdir(profileDirectory, { recursive: true });
  const profileUrl = pathToFileURL(profileDirectory).href;

  const timeoutMs = uploadConversionTimeoutMs();
  let stderr = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        binary,
        [
          `-env:UserInstallation=${profileUrl}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          outputDirectory,
          inputPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let timedOut = false;
      // LibreOffice can wedge on a malformed document and never exit, which
      // would hold this worker slot for the life of the process.
      const deadline = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      deadline.unref();
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-4_096);
      });
      child.once("error", (error) => {
        clearTimeout(deadline);
        // The binary was found but could not be started (removed since
        // discovery, not executable here): the converter is unavailable, and
        // the spawn error's errno rides along as the cause.
        reject(converterUnavailable(error));
      });
      child.once("close", (code) => {
        clearTimeout(deadline);
        if (timedOut) {
          reject(
            new ConversionError(
              "conversion.timeout",
              `LibreOffice conversion timed out after ${timeoutMs}ms`,
            ),
          );
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new ConversionError(
              "conversion.failed",
              `LibreOffice conversion failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`,
            ),
          );
        }
      });
    });
  } finally {
    // A killed child leaves lock files behind in its user profile.
    await fs.promises
      .rm(profileDirectory, { recursive: true, force: true })
      .catch(() => {});
  }

  const outputPath = path.join(
    outputDirectory,
    `${path.parse(inputPath).name}.pdf`,
  );
  try {
    await fs.promises.access(outputPath, fs.constants.R_OK);
  } catch (error) {
    // soffice exits 0 without writing anything when it cannot load the
    // source ("Error: source file could not be loaded" on stderr). That is a
    // rejected document, not a missing file: the code says so for callers,
    // the kind names the shape for Sentry, and LibreOffice's reason stays in
    // the message for the server log (the boundary keeps only code and kind).
    throw new ConversionError(
      "conversion.no_output",
      `LibreOffice exited without producing a PDF${stderr ? `: ${stderr}` : ""}`,
      { cause: error },
    );
  }
  return outputPath;
}

/**
 * Storage key of a document's PDF rendition. With a version slug the key is
 * per version, so a rendition never overwrites another version's.
 */
export function convertedPdfKey(
  userId: string,
  docId: string,
  versionSlug?: string,
): string {
  return versionSlug
    ? `converted-pdfs/${userId}/${docId}/${versionSlug}.pdf`
    : `converted-pdfs/${userId}/${docId}.pdf`;
}

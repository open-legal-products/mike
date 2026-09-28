import JSZip from "jszip";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * Some older Windows/Word archives store .docx entries with backslash
 * separators (e.g. `word\document.xml`). Mammoth and LibreOffice both look
 * up entries by exact string and miss those files, producing empty output
 * or conversion failures. Rewrite any such entries to the canonical
 * forward-slash form before handing the buffer off.
 */
export async function normalizeDocxZipPaths(buffer: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return buffer;
  }
  const renames: [string, string][] = [];
  zip.forEach((relativePath) => {
    if (relativePath.includes("\\")) {
      renames.push([relativePath, relativePath.replace(/\\/g, "/")]);
    }
  });
  if (renames.length === 0) return buffer;
  for (const [oldPath, newPath] of renames) {
    const entry = zip.file(oldPath);
    if (!entry) continue;
    const content = await entry.async("nodebuffer");
    zip.remove(oldPath);
    zip.file(newPath, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * Convert a DOCX/DOC buffer to PDF using LibreOffice.
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function docxToPdf(buffer: Buffer): Promise<Buffer> {
  if (resolveSofficeBinaryPaths().length === 0) {
    throw Object.assign(
      new Error(
        CONVERTER_UNAVAILABLE_MESSAGE,
      ),
      { code: "conversion_unavailable" },
    );
  }
  const convert = await getConvert();
  const normalized = await normalizeDocxZipPaths(buffer);
  return convert(normalized, ".pdf", undefined);
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
    throw Object.assign(
      new Error(
        CONVERTER_UNAVAILABLE_MESSAGE,
      ),
      { code: "conversion_unavailable" },
    );
  }

  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const profileDirectory = path.join(outputDirectory, "libreoffice-profile");
  await fs.promises.mkdir(profileDirectory, { recursive: true });
  const profileUrl = pathToFileURL(profileDirectory).href;

  const timeoutMs = uploadConversionTimeoutMs();
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
      let stderr = "";
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
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(deadline);
        if (timedOut) {
          reject(
            Object.assign(
              new Error(
                `LibreOffice conversion timed out after ${timeoutMs}ms`,
              ),
              { code: "conversion_timeout" },
            ),
          );
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            Object.assign(
              new Error(
                `LibreOffice conversion failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`,
              ),
              { code: "conversion_failed" },
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
  await fs.promises.access(outputPath, fs.constants.R_OK);
  return outputPath;
}

export function convertedPdfKey(userId: string, docId: string): string {
  return `converted-pdfs/${userId}/${docId}.pdf`;
}

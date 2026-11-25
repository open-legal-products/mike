// Compare two stored versions of one Word document. The result is a redline:
// the target version with every difference from the chosen baseline as a native
// tracked change, which any DOCX viewer (and Word) can show, accept or reject.
// Nothing is stored; the redline is computed per request from the two
// versions' bytes.

import { documentSuffix } from "../../lib/documentTypes";
import {
    DocxDiffError,
    getDocxDiffEngine,
    type DocxDiffEngine,
} from "../../lib/docxDiff";
import { loadActiveVersion, type ActiveVersion } from "../../lib/documentVersions";
import { downloadFile } from "../../lib/storage";
import type { Db } from "./documents.shared";
import { ensureDocumentAccess } from "./documents.access";

export const COMPARE_MAX_VERSION_BYTES = 20 * 1024 * 1024;

// Reserve capacity before reading either object. Each comparison owns up to two 20 MiB inputs.
let comparisonInProgress = false;

export const COMPARE_AUTHOR = "Mike comparison";

export type CompareVersionsFailure = {
    ok: false;
    kind: "not_found" | "invalid" | "too_large" | "unprocessable" | "busy";
    detail: string;
};

export type CompareVersionsResult =
    | { ok: true; redline: Buffer; filename: string }
    | CompareVersionsFailure;

function isDocx(version: ActiveVersion): boolean {
    // Older rows have no file_type; their filename still carries the suffix.
    const type = version.file_type?.toLowerCase() || documentSuffix(version.filename ?? "");
    return type === "docx";
}

function label(version: ActiveVersion): string {
    return version.version_number ? `V${version.version_number}` : "version";
}

function redlineFilename(base: ActiveVersion, target: ActiveVersion): string {
    const name = target.filename || base.filename || "document.docx";
    const stem = name.replace(/\.docx$/i, "");
    return `${stem} (${label(base)} to ${label(target)} comparison).docx`;
}

export async function compareVersions(params: {
    documentId: string;
    userId: string;
    userEmail: string | undefined;
    /** The baseline for the redline. */
    baseVersionId: string;
    /** The version produced by accepting every tracked change. */
    targetVersionId: string;
    db: Db;
    engine?: DocxDiffEngine;
    now?: Date;
}): Promise<CompareVersionsResult> {
    const { documentId, userId, userEmail, baseVersionId, targetVersionId, db } = params;
    if (!baseVersionId || !targetVersionId)
        return { ok: false, kind: "invalid", detail: "base and target versions are required." };
    if (baseVersionId === targetVersionId)
        return { ok: false, kind: "invalid", detail: "Choose two different versions to compare." };

    // One answer for a missing document and one the caller may not read, so
    // the endpoint cannot be used to probe for documents.
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok && access.kind === "error") throw access.error;
    if (!access.ok) return { ok: false, kind: "not_found", detail: "Document not found" };

    // loadActiveVersion only returns a live version that belongs to this
    // document, so a version id from another document reads as not found.
    const [base, target] = await Promise.all([
        loadActiveVersion(documentId, db, baseVersionId),
        loadActiveVersion(documentId, db, targetVersionId),
    ]);
    if (!base || !target || base.id !== baseVersionId || target.id !== targetVersionId)
        return { ok: false, kind: "not_found", detail: "Version not found" };
    if (!isDocx(base) || !isDocx(target))
        return { ok: false, kind: "invalid", detail: "Only Word (.docx) versions can be compared." };
    const tooLarge = (bytes: number | null | undefined) => (bytes ?? 0) > COMPARE_MAX_VERSION_BYTES;
    if (tooLarge(base.size_bytes) || tooLarge(target.size_bytes))
        return { ok: false, kind: "too_large", detail: "These versions are too large to compare." };

    if (comparisonInProgress)
        return { ok: false, kind: "busy", detail: "Another comparison is running. Please try again shortly." };
    comparisonInProgress = true;
    try {
        const [baseBytes, targetBytes] = await Promise.all([
            downloadFile(base.storage_path),
            downloadFile(target.storage_path),
        ]);
        if (!baseBytes || !targetBytes)
            return { ok: false, kind: "not_found", detail: "Document bytes not available" };
        // size_bytes is metadata; the stored object is what the engine will parse.
        if (tooLarge(baseBytes.byteLength) || tooLarge(targetBytes.byteLength))
            return { ok: false, kind: "too_large", detail: "These versions are too large to compare." };

        const engine = params.engine ?? getDocxDiffEngine();
        const redline = await engine.compare(Buffer.from(baseBytes), Buffer.from(targetBytes), {
            author: COMPARE_AUTHOR,
            date: params.now ?? new Date(),
        });
        return { ok: true, redline, filename: redlineFilename(base, target) };
    } catch (error) {
        if (error instanceof DocxDiffError)
            return { ok: false, kind: "unprocessable", detail: "These versions could not be compared." };
        throw error;
    } finally {
        comparisonInProgress = false;
    }
}

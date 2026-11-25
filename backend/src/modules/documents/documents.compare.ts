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
import { failure, ok, type ServiceResult } from "../../lib/serviceResult";
import { downloadFileWithinLimit } from "../../lib/storage";
import type { Db } from "./documents.shared";
import { ensureDocumentAccess } from "./documents.access";

export const COMPARE_MAX_VERSION_BYTES = 20 * 1024 * 1024;

// Reserve capacity before reading either object. Each comparison owns up to two 20 MiB inputs.
let comparisonInProgress = false;

export const COMPARE_AUTHOR = "Mike comparison";

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
}): Promise<ServiceResult<{ redline: Buffer; filename: string }>> {
    const { documentId, userId, userEmail, baseVersionId, targetVersionId, db } = params;
    if (!baseVersionId || !targetVersionId)
        return failure("validation", "base and target versions are required.");
    if (baseVersionId === targetVersionId)
        return failure("validation", "Choose two different versions to compare.");

    // One answer for a missing document and one the caller may not read, so
    // the endpoint cannot be used to probe for documents.
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok && access.kind === "error") throw access.error;
    if (!access.ok) return failure("not_found", "Document not found");

    // loadActiveVersion only returns a live version that belongs to this
    // document, so a version id from another document reads as not found.
    const [base, target] = await Promise.all([
        loadActiveVersion(documentId, db, baseVersionId),
        loadActiveVersion(documentId, db, targetVersionId),
    ]);
    if (!base || !target || base.id !== baseVersionId || target.id !== targetVersionId)
        return failure("not_found", "Version not found");
    if (!isDocx(base) || !isDocx(target))
        return failure("validation", "Only Word (.docx) versions can be compared.");
    const tooLarge = (bytes: number | null | undefined) => (bytes ?? 0) > COMPARE_MAX_VERSION_BYTES;
    if (tooLarge(base.size_bytes) || tooLarge(target.size_bytes))
        return failure("too_large", "These versions are too large to compare.");

    if (comparisonInProgress)
        return failure("busy", "Another comparison is running. Please try again shortly.");
    comparisonInProgress = true;
    try {
        // Both reads own the slot, including when one of them fails.
        const [original, revised] = await Promise.allSettled([
            downloadFileWithinLimit(base.storage_path, COMPARE_MAX_VERSION_BYTES),
            downloadFileWithinLimit(target.storage_path, COMPARE_MAX_VERSION_BYTES),
        ]);
        if (original.status === "rejected") throw original.reason;
        if (revised.status === "rejected") throw revised.reason;
        if (original.value === null || revised.value === null)
            return failure("not_found", "Document bytes not available");
        if (original.value === "too_large" || revised.value === "too_large")
            return failure("too_large", "These versions are too large to compare.");

        const engine = params.engine ?? getDocxDiffEngine();
        const redline = await engine.compare(original.value, revised.value, {
            author: COMPARE_AUTHOR,
            date: params.now ?? new Date(),
        });
        return ok({ redline, filename: redlineFilename(base, target) });
    } catch (error) {
        if (error instanceof DocxDiffError)
            return failure("unprocessable", "These versions could not be compared.");
        throw error;
    } finally {
        comparisonInProgress = false;
    }
}

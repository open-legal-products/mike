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

// Reserve capacity before reading either comparison input.
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
    if (comparisonInProgress)
        return failure("busy", "Another comparison is running. Please try again shortly.");
    comparisonInProgress = true;
    try {
        const engine = params.engine ?? getDocxDiffEngine();
        const readInput = (version: ActiveVersion) => (version.size_bytes ?? 0) > engine.maxInputBytes
            ? "too_large" as const
            : downloadFileWithinLimit(version.storage_path, engine.maxInputBytes);
        // Both reads own the slot, including when one of them fails.
        const [original, revised] = await Promise.allSettled([readInput(base), readInput(target)]);
        if (original.status === "rejected") throw original.reason;
        if (revised.status === "rejected") throw revised.reason;
        if (original.value === "too_large" || revised.value === "too_large") {
            const name = (version: ActiveVersion, role: string) =>
                `${version.filename || "Word document"} (${version.version_number == null ? role : label(version)})`;
            const files = [];
            if (original.value === "too_large") files.push(name(base, "baseline"));
            if (revised.value === "too_large") files.push(name(target, "target"));
            const limitMiB = engine.maxInputBytes / (1024 * 1024);
            return failure("too_large",
                `${files.join(" and ")} ${files.length === 1 ? "exceeds" : "exceed"} the ${limitMiB} MiB limit for comparison.`,
                "comparison_input_too_large");
        }
        if (original.value === null || revised.value === null)
            return failure("not_found", "Document bytes not available");
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

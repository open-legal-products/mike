import type { DocumentVersion } from "@/app/lib/mikeApi";

/** Two versions of one document: the redline shows how `target` differs from `base`. */
export interface VersionComparison {
    base: DocumentVersion;
    target: DocumentVersion;
}

function isWordVersion(version: DocumentVersion): boolean {
    // Older rows have no file_type; their filename still carries the suffix.
    const type = version.file_type?.toLowerCase() ?? version.filename?.split(".").pop()?.toLowerCase();
    return type === "docx";
}

/**
 * The comparison "Compare with previous version" opens for the displayed
 * version: against the nearest earlier version that is still available and is
 * also a Word document. Null when there is nothing to compare with.
 */
export function comparisonWithPrevious(
    versions: readonly DocumentVersion[],
    selectedId: string,
): VersionComparison | null {
    const target = versions.find((version) => version.id === selectedId);
    if (!target || target.deleted_at || !isWordVersion(target) || target.version_number == null) return null;
    const base = versions
        .filter((version) => !version.deleted_at && isWordVersion(version)
            && version.version_number != null && version.version_number < target.version_number!)
        .sort((a, b) => b.version_number! - a.version_number!)[0];
    return base ? { base, target } : null;
}

export function versionLabel(version: DocumentVersion): string {
    return version.version_number ? `V${version.version_number}` : "an earlier version";
}

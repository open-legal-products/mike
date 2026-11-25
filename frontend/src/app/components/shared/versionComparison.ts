import type { DocumentVersion } from "@/app/lib/mikeApi";

/** Two versions of one document: the redline shows how `target` differs from `base`. */
export interface VersionComparison {
    base: DocumentVersion;
    target: DocumentVersion;
}

function isWordVersion(version: DocumentVersion): boolean {
    // Older rows have no file_type; their filename still carries the suffix.
    const type = version.file_type?.toLowerCase() || version.filename?.split(".").pop()?.toLowerCase();
    return type === "docx";
}

/** Keep the displayed version as the target, even when the baseline is newer. */
export function versionComparisons(
    versions: readonly DocumentVersion[],
    selectedId: string | null,
): VersionComparison[] {
    const available = versions.filter((version) => !version.deleted_at && isWordVersion(version));
    const target = available.find((version) => version.id === selectedId);
    if (!target) return [];
    return available
        .filter((version) => version.id !== target.id)
        .sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0)
            || b.created_at.localeCompare(a.created_at))
        .map((base) => ({ base, target }));
}

export function versionLabel(version: DocumentVersion): string {
    return version.version_number != null ? `V${version.version_number}` : `version from ${version.created_at.split("T")[0]}`;
}

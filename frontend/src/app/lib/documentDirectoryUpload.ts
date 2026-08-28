export type DocumentUploadEntry = {
    file: File;
    relativePath: string;
};

// Pre-flight ceiling for one drop/selection. The upload client chunks large
// selections into <=50-file sessions itself, so this is not the session limit —
// it only stops a mis-drop (say, a home directory) from queueing hundreds of
// sessions against the 50-session hourly cap. 500 files = at most 10 sessions.
export const MAX_DOCUMENTS_PER_DIRECTORY_UPLOAD = 500;
export const DOCUMENT_UPLOAD_CONCURRENCY = 2;

export type DocumentUploadProgressEntry = {
    kind: "file" | "folder";
    name: string;
    sourceName: string;
};

export function folderUploadProgressLabel(
    statuses: readonly string[],
): string {
    const uploadedCount = statuses.filter((status) =>
        ["uploaded", "processing", "completed"].includes(status),
    ).length;
    return `${uploadedCount} of ${statuses.length} uploaded`;
}

export type DocumentUploadFolderPathResolution<TFolder> =
    | {
          conflict: true;
          folder_name: string;
          existing_folder_id: string;
          suggested_name: string;
      }
    | {
          conflict: false;
          folder_id: string;
          resolved_name: string;
          folders: TFolder[];
      };

export async function resolveDocumentUploadRootFolder<TFolder>({
    rootFolderName,
    baseFolderId,
    resolveFolderPath,
    chooseConflict,
}: {
    rootFolderName: string;
    baseFolderId: string | null;
    resolveFolderPath: (
        segments: string[],
        baseFolderId: string | null,
        conflictResolution?: "error" | "reuse" | "rename",
    ) => Promise<DocumentUploadFolderPathResolution<TFolder>>;
    chooseConflict: (
        conflict: Extract<
            DocumentUploadFolderPathResolution<TFolder>,
            { conflict: true }
        >,
    ) => Promise<"rename" | "cancel">;
}): Promise<
    | Extract<
          DocumentUploadFolderPathResolution<TFolder>,
          { conflict: false }
      >
    | null
> {
    let resolution = await resolveFolderPath(
        [rootFolderName],
        baseFolderId,
    );
    while (resolution.conflict) {
        const choice = await chooseConflict(resolution);
        if (choice === "cancel") return null;
        resolution = await resolveFolderPath(
            [rootFolderName],
            baseFolderId,
            "rename",
        );
    }
    return resolution;
}

type DroppedFileEntry = {
    isFile: true;
    isDirectory: false;
    name: string;
    file: (
        success: (file: File) => void,
        error?: (error: DOMException) => void,
    ) => void;
};

type DroppedDirectoryReader = {
    readEntries: (
        success: (entries: DroppedEntry[]) => void,
        error?: (error: DOMException) => void,
    ) => void;
};

type DroppedDirectoryEntry = {
    isFile: false;
    isDirectory: true;
    name: string;
    createReader: () => DroppedDirectoryReader;
};

type DroppedEntry = DroppedFileEntry | DroppedDirectoryEntry;

type DirectoryDataTransferItem = {
    webkitGetAsEntry?: () => DroppedEntry | null;
};

export function documentUploadEntriesFromFiles(
    files: Iterable<File>,
): DocumentUploadEntry[] {
    return Array.from(files, (file) => ({
        file,
        relativePath: file.webkitRelativePath || file.name,
    }));
}

export function documentUploadPathSegments(
    entry: Pick<DocumentUploadEntry, "relativePath" | "file">,
): string[] {
    const path = entry.relativePath || entry.file.name;
    return path
        .replace(/\\/g, "/")
        .split("/")
        .map((segment) => segment.trim())
        .filter(
            (segment) =>
                segment.length > 0 && segment !== "." && segment !== "..",
        );
}

export function documentUploadFolderSegments(
    entry: Pick<DocumentUploadEntry, "relativePath" | "file">,
): string[] {
    return documentUploadPathSegments(entry).slice(0, -1);
}

export function documentUploadProgressEntries(
    entries: readonly DocumentUploadEntry[],
): DocumentUploadProgressEntry[] {
    const progressEntries: DocumentUploadProgressEntry[] = [];
    const folderNames = new Set<string>();

    for (const entry of entries) {
        const segments = documentUploadPathSegments(entry);
        if (segments.length > 1) {
            const folderName = segments[0];
            if (!folderNames.has(folderName)) {
                folderNames.add(folderName);
                progressEntries.push({
                    kind: "folder",
                    name: folderName,
                    sourceName: folderName,
                });
            }
            continue;
        }
        progressEntries.push({
            kind: "file",
            name: segments[0] ?? entry.file.name,
            sourceName: segments[0] ?? entry.file.name,
        });
    }

    return progressEntries;
}

export function resolvedDocumentUploadProgressEntries(
    entries: readonly DocumentUploadEntry[],
    resolvedRootFolderNames: ReadonlyMap<string, string>,
): DocumentUploadProgressEntry[] {
    return documentUploadProgressEntries(entries).flatMap((entry) => {
        if (entry.kind === "file") return [entry];
        const resolvedName = resolvedRootFolderNames.get(entry.name);
        return resolvedName
            ? [{ ...entry, name: resolvedName }]
            : [];
    });
}

export function dataTransferHasDirectory(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.items).some((item) => {
        const entry = (item as unknown as DirectoryDataTransferItem)
            .webkitGetAsEntry?.();
        return entry?.isDirectory === true;
    });
}

function readFile(entry: DroppedFileEntry): Promise<File> {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectoryEntries(
    entry: DroppedDirectoryEntry,
): Promise<DroppedEntry[]> {
    const reader = entry.createReader();
    const result: DroppedEntry[] = [];
    while (true) {
        const batch = await new Promise<DroppedEntry[]>((resolve, reject) =>
            reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) return result;
        result.push(...batch);
    }
}

async function walkDroppedEntry(
    entry: DroppedEntry,
    parentPath: string,
): Promise<DocumentUploadEntry[]> {
    const relativePath = parentPath
        ? `${parentPath}/${entry.name}`
        : entry.name;
    if (entry.isFile) {
        const file = await readFile(entry);
        return [{ file, relativePath }];
    }

    const children = await readDirectoryEntries(entry);
    return (
        await Promise.all(
            children.map((child) => walkDroppedEntry(child, relativePath)),
        )
    ).flat();
}

export async function collectDroppedDocumentUploadEntries(
    dataTransfer: DataTransfer,
): Promise<DocumentUploadEntry[]> {
    const entries = Array.from(dataTransfer.items)
        .filter((item) => item.kind === "file")
        .map((item) =>
            (item as unknown as DirectoryDataTransferItem)
                .webkitGetAsEntry?.(),
        )
        .filter((entry): entry is DroppedEntry => !!entry);

    if (entries.length === 0) {
        return documentUploadEntriesFromFiles(dataTransfer.files);
    }
    return (await Promise.all(entries.map((entry) => walkDroppedEntry(entry, "")))).flat();
}

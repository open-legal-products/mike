import type { DuplicateDocumentMatch } from "@/app/lib/mikeApi";
import { sha256Hex } from "@/app/lib/fileHash";

/** A file about to be uploaded whose exact bytes are already there. */
export type UploadDuplicate<E> =
    | {
          entry: E;
          kind: "existing";
          /** Documents in the destination with the same content. */
          matches: DuplicateDocumentMatch[];
      }
    | {
          entry: E;
          kind: "selection";
          /** The earlier file in the same selection with the same content. */
          sameAs: string;
      };

const HASH_CONCURRENCY = 2;
/** The duplicate endpoints accept at most this many hashes per request. */
export const HASHES_PER_REQUEST = 100;

/**
 * Find exact duplicates among files about to be uploaded: files whose bytes
 * already exist as a document in the destination (asked via `find`), and
 * repeats within the selection itself (the first one is kept).
 *
 * Returns null when the check cannot run — no Web Crypto, an unreadable file,
 * or a failed request. The upload then goes ahead unchecked: a duplicate
 * warning is a convenience and must never block an upload.
 */
export async function findUploadDuplicates<E extends { file: File }>(
    entries: E[],
    find: (hashes: string[]) => Promise<Record<string, DuplicateDocumentMatch[]>>,
    hash: (file: File) => Promise<string | null> = sha256Hex,
): Promise<UploadDuplicate<E>[] | null> {
    if (entries.length === 0) return [];
    const hashes: (string | null)[] = new Array(entries.length).fill(null);
    let next = 0;
    const worker = async () => {
        while (next < entries.length) {
            const index = next++;
            hashes[index] = await hash(entries[index].file);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(HASH_CONCURRENCY, entries.length) }, worker),
    );
    if (hashes.some((value) => value === null)) return null;

    // Asked in requests of at most 100 hashes (a folder upload can hold far
    // more files); one failed request means the check cannot run.
    const unique = [...new Set(hashes as string[])];
    const existing: Record<string, DuplicateDocumentMatch[]> = {};
    try {
        for (let i = 0; i < unique.length; i += HASHES_PER_REQUEST) {
            Object.assign(
                existing,
                await find(unique.slice(i, i + HASHES_PER_REQUEST)),
            );
        }
    } catch {
        return null;
    }

    const firstByHash = new Map<string, string>();
    const duplicates: UploadDuplicate<E>[] = [];
    entries.forEach((entry, index) => {
        const value = hashes[index] as string;
        const matches = existing[value] ?? [];
        if (matches.length > 0) {
            duplicates.push({ entry, kind: "existing", matches });
            return;
        }
        const first = firstByHash.get(value);
        if (first !== undefined) {
            duplicates.push({ entry, kind: "selection", sameAs: first });
            return;
        }
        firstByHash.set(value, entry.file.name);
    });
    return duplicates;
}

/** One readable line per duplicate, for the confirmation dialog. */
export function describeUploadDuplicate<E extends { file: File }>(
    duplicate: UploadDuplicate<E>,
): string {
    const name = duplicate.entry.file.name;
    if (duplicate.kind === "selection") {
        return `${name}: same file as ${duplicate.sameAs} in this upload`;
    }
    const names = duplicate.matches.map((match) => match.filename);
    const shown = names.slice(0, 2).join(", ");
    const more = names.length > 2 ? ` and ${names.length - 2} more` : "";
    return `${name}: already here as ${shown}${more}`;
}

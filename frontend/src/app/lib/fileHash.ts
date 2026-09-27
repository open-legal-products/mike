/**
 * SHA-256 of a file's bytes as lower-case hex: the same value the backend
 * stores in document_versions.content_sha256 for an upload, so the two can
 * be compared to find exact duplicates before uploading.
 *
 * Returns null where the Web Crypto digest is unavailable (an insecure
 * origin) or the file cannot be read; callers then skip the duplicate check
 * rather than block the upload.
 */
export async function sha256Hex(file: Blob): Promise<string | null> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    try {
        const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
        return Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
    } catch {
        return null;
    }
}

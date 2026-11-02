// Bounded raster data URLs for small profile and organization images.
/** Maximum stored image size before base64 encoding. */
export const MAX_PROFILE_IMAGE_BYTES = 512 * 1024;

type ProfileImageContentType = "image/png" | "image/jpeg" | "image/webp";

// What each accepted format begins with. The declared type is the client's
// word; these are the file's. SVG is deliberately absent: it is a document
// that can carry script, not a picture.
/** Checks raster magic bytes against the declared MIME type without decoding image content. */
function hasImageSignature(contentType: ProfileImageContentType, bytes: Buffer): boolean {
    switch (contentType) {
        case "image/png":
            return bytes.subarray(0, 8).equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            );
        case "image/jpeg":
            return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        case "image/webp":
            return bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
                bytes.subarray(8, 12).toString("latin1") === "WEBP";
    }
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Check a raster data URL's type, file signature and size. Returns the
 * canonical base64 value to store; the browser decodes uploads before cropping.
 */
export function parseProfileImageDataUrl(
    value: unknown,
    label = "image",
):
    | { ok: true; contentType: ProfileImageContentType; base64: string }
    | { ok: false; detail: string } {
    const unsupported = `The ${label} must be a PNG, JPEG or WebP image.`;
    if (typeof value !== "string" || !value)
        return { ok: false, detail: "data_url is required" };
    // Refuse an oversized body before running a pattern over it. Base64 is
    // four characters for every three bytes, plus the short prefix.
    if (value.length > Math.ceil(MAX_PROFILE_IMAGE_BYTES / 3) * 4 + 64)
        return { ok: false, detail: `The ${label} is too large. Use an image under 512 KB.` };
    const match = DATA_URL.exec(value);
    if (!match) return { ok: false, detail: unsupported };
    const contentType = match[1];
    if (contentType !== "image/png" && contentType !== "image/jpeg" && contentType !== "image/webp")
        return { ok: false, detail: unsupported };
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0) return { ok: false, detail: unsupported };
    if (bytes.length > MAX_PROFILE_IMAGE_BYTES)
        return { ok: false, detail: `The ${label} is too large. Use an image under 512 KB.` };
    if (!hasImageSignature(contentType, bytes))
        return { ok: false, detail: unsupported };
    // Re-encoded from the decoded bytes, so what is stored is canonical.
    return { ok: true, contentType, base64: bytes.toString("base64") };
}

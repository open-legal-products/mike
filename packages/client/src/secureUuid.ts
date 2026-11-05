/**
 * Generate a UUID with Web Crypto. Older Office WebViews may not expose
 * randomUUID(), so retain a secure getRandomValues() compatibility path.
 *
 * This lives in shared/ because both the web app and the Word add-in run the
 * same upload-session client, and that client mints client ids before it can
 * know which host it is running in.
 */
export function createSecureUuid(): string {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.randomUUID === "function") {
        return cryptoApi.randomUUID();
    }

    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return [
        hex.slice(0, 4).join(""),
        hex.slice(4, 6).join(""),
        hex.slice(6, 8).join(""),
        hex.slice(8, 10).join(""),
        hex.slice(10).join(""),
    ].join("-");
}

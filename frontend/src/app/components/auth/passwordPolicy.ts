export const MIN_PASSWORD_LENGTH = 10;

/**
 * bcrypt hashes at most 72 BYTES of input, so GoTrue refuses anything
 * longer. Bytes, not characters: "é" is two, an emoji is four, and a
 * `password.length > 72` check lets a 40-character passphrase through the
 * form only for the API to reject it — a failure the user cannot explain.
 */
export const MAX_PASSWORD_LENGTH = 72;

export const minimumPasswordMessage = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
export const maximumPasswordMessage = `Password must be at most ${MAX_PASSWORD_LENGTH} UTF-8 bytes. Accented characters and emoji can use more than one byte.`;

/** What the 72-byte limit actually counts. */
export function passwordByteLength(password: string): number {
    return new TextEncoder().encode(password).length;
}

export function isPasswordTooLong(password: string): boolean {
    return passwordByteLength(password) > MAX_PASSWORD_LENGTH;
}

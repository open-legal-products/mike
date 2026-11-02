import crypto from "crypto";

/**
 * Ed25519 signing for project export manifests.
 *
 * A manifest carries a SHA-256 per document version, which proves an exported
 * file has not changed *if you trust the manifest*. Signing closes that gap:
 * the manifest's own digest is signed with a server-held key, so a recipient
 * holding the deployment's public key can tell an untouched manifest from an
 * edited one.
 *
 * Optional by design. Mike self-hosts, and a deployment that has not set up a
 * key should still be able to export — it just gets `signature: null` and the
 * weaker guarantee. Set MANIFEST_SIGNING_KEY to turn signing on; a malformed
 * key throws rather than silently downgrading to unsigned, because a manifest
 * that is quietly unsigned is the failure signing exists to prevent.
 *
 * Key material is a raw 32-byte Ed25519 seed, hex-encoded, matching the
 * `openssl rand -hex 32` pattern already used for DOWNLOAD_SIGNING_SECRET.
 */

// PKCS#8 DER prefix for an Ed25519 private key (RFC 8410). Node will not build
// a key object from a bare 32-byte seed, so the seed is wrapped in this fixed
// envelope first. Ed25519 seeds and public keys are both 32 bytes.
const PKCS8_ED25519_PREFIX = Buffer.from(
    "302e020100300506032b657004220420",
    "hex",
);
const ED25519_KEY_BYTES = 32;

/**
 * Domain separation. The signature covers this context string and a NUL byte
 * before the digest bytes, so a manifest signature can never be replayed as a
 * signature over some other object that hashes to the same 32 bytes. Bump the
 * version suffix if the signed payload's shape changes.
 */
const SIGNING_CONTEXT = "mike-project-manifest-v1";

function signedPayload(digestHex: string): Buffer {
    return Buffer.concat([
        Buffer.from(`${SIGNING_CONTEXT}\0`, "utf8"),
        Buffer.from(digestHex, "hex"),
    ]);
}

export interface ManifestSignature {
    algorithm: "ed25519";
    /** First 16 hex chars of SHA-256 over the raw public key. Rotation aid. */
    key_id: string;
    /** Raw Ed25519 public key, hex. */
    public_key: string;
    /** Signature over SIGNING_CONTEXT + NUL + the raw digest bytes, hex. */
    value: string;
}

export interface ManifestDigest {
    algorithm: "sha256";
    value: string;
}

export interface SigningIdentity {
    algorithm: "ed25519";
    key_id: string;
    public_key: string;
}

function seedFromEnv(): Buffer | null {
    const raw = process.env.MANIFEST_SIGNING_KEY?.trim();
    if (!raw) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        throw Object.assign(new Error(
            "MANIFEST_SIGNING_KEY must be a 32-byte hex string " +
                "(generate with `openssl rand -hex 32`). Unset it to export " +
                "unsigned manifests.",
        ), { code: "signing_key_invalid" });
    }
    return Buffer.from(raw, "hex");
}

/**
 * The configured signing key, or null when signing is off. Signing and key
 * publication both go through here so they cannot disagree about the key id.
 */
function signingKey(): {
    privateKey: crypto.KeyObject;
    identity: SigningIdentity;
} | null {
    const seed = seedFromEnv();
    if (!seed) return null;

    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
    });
    const spki = crypto.createPublicKey(privateKey).export({
        format: "der",
        type: "spki",
    }) as Buffer;
    const publicKeyRaw = spki.subarray(spki.length - ED25519_KEY_BYTES);

    return {
        privateKey,
        identity: {
            algorithm: "ed25519",
            key_id: crypto
                .createHash("sha256")
                .update(publicKeyRaw)
                .digest("hex")
                .slice(0, 16),
            public_key: publicKeyRaw.toString("hex"),
        },
    };
}

/**
 * The deployment's manifest public key, or null when signing is off. Served
 * over HTTP so a recipient can get the key from the deployment rather than
 * trusting the copy inside the manifest they were handed — anyone who edits a
 * manifest can re-sign it with a key of their own.
 */
export function manifestPublicKey(): SigningIdentity | null {
    return signingKey()?.identity ?? null;
}

/**
 * Deterministic JSON: object keys sorted, no whitespace.
 *
 * A verifier holding only the parsed manifest has to recompute the same
 * digest, and JSON parsers do not preserve key order. Sorting is therefore
 * part of the format, not an implementation detail. (RFC 8785 in spirit; the
 * manifest holds no floats, so that spec's number rules do not bite.)
 */
export function canonicalize(value: unknown): string {
    // NaN and Infinity both stringify to "null", which would let two different
    // bodies share a digest. Nothing in a manifest is a float, so this guards
    // a case that should not arise — but a digest collision is the one thing
    // canonicalisation must not permit.
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("Manifest bodies must hold finite numbers");
    }
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

    // Anything that is not a plain object serialises wrongly and quietly: a
    // Date becomes {} where JSON.stringify gives an ISO string, a Buffer
    // enumerates its indices, a Map becomes {}. A manifest body only ever
    // holds JSON from the database, so this should not arise — but a silently
    // wrong serialisation is the same failure as the non-finite number above,
    // and this function is what every digest rests on.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Manifest bodies must hold plain objects");
    }

    return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
        .join(",")}}`;
}

/** SHA-256 over the canonical form of the manifest body. */
export function digestManifestBody(body: unknown): ManifestDigest {
    return {
        algorithm: "sha256",
        value: crypto
            .createHash("sha256")
            .update(canonicalize(body), "utf8")
            .digest("hex"),
    };
}

/**
 * Attach `digest` and `signature` to a manifest body.
 *
 * The digest covers the body only — neither `digest` nor `signature` is an
 * input to itself. The signature is a raw Ed25519 signature over
 * SIGNING_CONTEXT + NUL + the digest bytes, so it can be checked with any
 * Ed25519 implementation and none of this code.
 */
export function sealManifest<T extends Record<string, unknown>>(
    body: T,
): T & { digest: ManifestDigest; signature: ManifestSignature | null } {
    const digest = digestManifestBody(body);
    const key = signingKey();
    if (!key) return { ...body, digest, signature: null };

    return {
        ...body,
        digest,
        signature: {
            ...key.identity,
            value: crypto
                .sign(null, signedPayload(digest.value), key.privateKey)
                .toString("hex"),
        },
    };
}

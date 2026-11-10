// Staged uploads: objects the browser PUTs with a presigned URL before an
// import or a supplementary-document add reads (and then deletes) them. The
// client echoes the key back, so it is untrusted input that reaches storage
// reads and deletes.
//
// Each key lives under a per-user prefix, but a prefix check alone is not an
// ownership boundary: "playbooks/<me>/imports/../../../documents/<them>/…"
// starts with the right prefix and, on the filesystem driver, resolves to
// another account's file. So a staged key must be exactly what the upload-URL
// route minted — the caller's prefix, a random UUID, a known extension —
// with nothing else in it.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STAGED_IMPORT_NAME = new RegExp(`^${UUID}\\.(?:docx|pdf)$`);
const STAGED_SOURCE_NAME = new RegExp(`^${UUID}\\.(?:docx|pdf)$`);

export function playbookImportPrefix(userId: string): string {
  return `playbooks/${userId}/imports/`;
}

export function playbookSourceUploadPrefix(userId: string): string {
  return `playbooks/${userId}/source-uploads/`;
}

function isStagedKey(prefix: string, name: RegExp, key: unknown): boolean {
  return (
    typeof key === "string" &&
    key.startsWith(prefix) &&
    name.test(key.slice(prefix.length))
  );
}

/** True only for a playbook import key minted for this user. */
export function isStagedPlaybookImportKey(userId: string, key: unknown): boolean {
  return isStagedKey(playbookImportPrefix(userId), STAGED_IMPORT_NAME, key);
}

/** True only for a supplementary-document upload key minted for this user. */
export function isStagedPlaybookSourceKey(userId: string, key: unknown): boolean {
  return isStagedKey(
    playbookSourceUploadPrefix(userId),
    STAGED_SOURCE_NAME,
    key,
  );
}

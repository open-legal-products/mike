# Mike Research Pack Edit Package v0.1

The Research Pack reader accepts a verified Counterpedia portable Research Pack
v0.2. Mike edits are stored as a separate, account-scoped local history and may
be exported as `mike.research_pack_edit.v0.1`. This schema is not a
Counterpedia Research Pack and must not be presented as one.

## Data carried

- `base_pack` records the original filename, Counterpedia schema, exact input
  SHA-256, selected source revision, and the original file bytes as base64.
- `base_revision_sha256` binds the local history to the selected original
  revision.
- `local_revisions` is append-only. Each revision stores editable finding
  text, proposition/observation assessment stances and notes, and
  research-context review decisions and notes. `parent_sha256` links to the
  previous local edit digest, beginning with the base revision digest.
- `package_sha256` is a SHA-256 corruption check over the package object with
  that field omitted. `authenticity: "not_established"` is deliberate: these
  hashes are not a signature, identity, claim admission, or proof of authorship.

The editor overlays only those user-authored fields. It preserves the
Counterpedia pack bytes, its references, observations, export-time readback and
authenticity fields unchanged. Reopening a saved or exported edit verifies the
Mike package hashes, then sends the embedded original v0.2 bytes through the
existing authenticated local verifier before displaying the edits.

## Persistence and limits

The browser stores edit packages in IndexedDB under the signed-in account ID.
This is per-browser-profile storage, is not encrypted by Mike, and does not sync
between devices. The user can export a portable Mike edit package or delete a
local package. Clearing browser site data also clears local packages. An import
of a Mike edit package associates it with the currently signed-in account only
after the embedded Counterpedia pack verifies.

The existing Counterpedia verifier still limits incoming Research Packs to 4
MiB. Imported Mike edit packages are limited to 16 MiB. No recorded source
address is fetched, and editing does not refresh or change export-time source
availability.

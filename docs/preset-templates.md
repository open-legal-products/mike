# Preset contract templates

Feature proposal: [#560](https://github.com/open-legal-products/mike/issues/560).

## Problem

Library → Templates accepts uploads, but users must find and download a starting
document outside Mike before they can use it. The public contract collection
downloaded on 2026-09-30 contains reusable agreements and supporting documents
from General Legal, Common Paper, and Bonterms.

## Proposed solution

Add **Browse presets** to Library → Templates. Users can search by name or
publisher, inspect source and license information, download an original, or
choose **Add to templates** to save a personal copy in the current folder.
Keep the publishers' original files and directory structure intact, including
agreement variants and formation-package instructions. The initial catalog has
81 PDF/DOCX templates and four Markdown references. Markdown is download-only
because the existing document pipeline does not support that format.

## Technical approach / affected areas

- Bundle the supplied public files under `frontend/public/preset-templates/`.
  A checked-in manifest records each relative path, publisher, format, byte size,
  and SHA-256 checksum. No publisher requests are needed at runtime.
- Compose a searchable preset dialog from the existing Modal, SearchBar, and
  button primitives. Long names wrap; source and license information remain
  visible at narrow widths.
- Fetch the selected same-origin asset, then reuse `uploadLibraryDocument` with
  collection `templates` and the current folder. The existing upload-session
  API owns authentication, folder access, storage, processing, and document
  version creation. No new backend endpoint or database migration is needed.
- Refresh the displayed collection after an import. Show progress, success, and
  recoverable failure states; disable repeat clicks during an upload and after
  success for that dialog session. A later deliberate import creates another
  independent copy and never overwrites an existing template.
- Preserve source/license notices and distinguish Bonterms' per-document license
  exceptions. Catalog updates never replace users' imported copies.

## Non-goals / out of scope

Automatic installation for every account, synchronizing imported documents with
publisher updates, remote catalog administration, and changes to template editing
or assistant replication rules.

## Alternatives considered

A backend catalog and import endpoint would support centrally administered
catalogs but adds a new storage and authorization path. For this small, public,
versioned collection, bundled assets and the existing upload API are sufficient.
Linking directly to publisher downloads would make imports depend on publisher
availability and cross-origin permissions.

## Success metrics / acceptance criteria

- Every document in the supplied collection is available with original bytes.
- Search includes the publisher and package path, making variants distinguishable.
- Import targets the signed-in user's Templates collection and selected folder.
- Upload failures remain retryable and do not report success.
- Long filenames and actions fit mobile and desktop dialog widths.
- Asset integrity, import behavior, search, and failure handling have focused
  automated coverage.

## Open questions

None blocking the initial collection. A persistent imported/version indicator can
be added later if users need catalog upgrade tracking.

## Maintaining the catalog

Add original public files beneath the relevant publisher directory in
`frontend/public/preset-templates/`, then run
`node scripts/build-preset-templates.mjs`. Commit the files and regenerated
`frontend/src/app/components/library/presetTemplates.json` together. The integrity
test verifies that every public file is cataloged and its checksum still matches.
Hidden filesystem files are excluded. Only PDF, DOCX, and Markdown are accepted.

Publisher credits and licenses:

- [General Legal](https://general.legal/library):
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- [Common Paper](https://commonpaper.com/standards/):
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- [Bonterms](https://bonterms.com/download-center/): generally CC BY 4.0, with
  per-document exceptions including CC BY-ND 4.0. Consult the notice in each file.

All bundled publisher files are unmodified. Their licenses are separate from
Mike's software license, and attribution and other notices remain in the files.
The snapshot was downloaded on 2026-09-30; adding a new publisher requires updating
the generator's publisher metadata and verifying the supplied files' notices.

# Read-only legacy spreadsheet values

The legacy `.xls` viewer can show stored BIFF8 cell values without converting or
editing the original. This is a values table, not a full-fidelity Excel renderer.
OOXML `.xlsx`/`.xlsm` continues through the existing viewer.

## Reading the preview

- Cells retain their original sheet names, A1 coordinates, available formatted
  strings, whitespace and newlines. Hidden sheets, rows and columns are labelled
  and remain selectable/visible. Merged ranges are listed; their layout is not
  reproduced. Rows are paginated without renumbering source coordinates.
- Formula results are **stored caches**, not checked calculations. A stale cache
  remains stale: the preview never evaluates formulas, macros or external links.
  Cached blank results are explicitly distinguished from unusable/missing ones.
  Text beginning with `=` remains text. Cell content is escaped, never HTML.
- Styling, charts, images, comments and print layout are not displayed. BIFF8
  chart/macro-sheet substreams, older BIFF formats, declared encryption and
  malformed input are refused rather than partially represented as complete.
- Each successful preview identifies its document, version and original SHA-256.
  **Download previewed original** requests those exact bytes again. If the source
  was overwritten in place, moved out of the reader's access or deleted, the
  download is refused; it never silently substitutes the current file. Existing
  original-download controls remain available when no preview can be produced;
  they retain their existing requested/current-version behavior. Only the
  specifically labelled preview-download button enforces the byte checkpoint.

## Limits and source boundaries

Limits currently fail the entire preview, without silent truncation: 5 MiB input,
8 sheets, 200 rows/50 columns per used range, 5,000 total range positions and
stored cells, 512 UTF-8 bytes per display string, and 1 MiB serialized values.
These are initial admission limits for a bounded feature, not format-wide XLS
support. Maintainers should review their practical suitability before release.

A known `.xls` filename/type hint selects the server preview before the raw-byte
browser hook. The hint never proves the format: the isolated decoder inspects
the actual CFB/BIFF8 bytes. A mislabelled OLE fallback has already used the
existing raw-byte hook, so that compatibility path does not establish a new
browser input-memory bound. Arbitrary asset/display URLs cannot be trusted as
saved revisions and fail explicitly instead of receiving a false checkpoint.

## API and authorization

Both endpoints require the existing document authentication middleware:

- `GET /single-documents/:documentId/spreadsheet-preview`: optional scalar
  `version_id`; resolves the active version once when omitted.
- `GET /single-documents/:documentId/spreadsheet-preview/source`: required scalar
  `version_id` and lowercase 64-character `sha256`, from the successful preview.

Unexpected, bracketed or duplicate query parameters are rejected. An explicit
historical version never falls back to another revision. Version lookup is
document-scoped and excludes deleted rows. The current document's project,
workflow and organization access rules apply to historical reads too.

Every request authorizes before storage access and rechecks before returning
values/bytes. Stored content hashes, when present, must match read bytes;
version path/hash changes and deletion during work invalidate the response.
Older rows without a stored hash still get a computed byte checkpoint. Advancing
the active pointer does not relabel an already resolved historical result.

Authorization rechecks are phase checks, not a database/storage transaction or
an assertion of atomic concurrent revocation. Already delivered browser content
cannot be recalled. No persistent preview cache or additional stored source
copy is created. Responses use private/no-store and nosniff headers; source
paths and raw provider/parser exceptions are not returned.

## Parser and resource boundary

The `spreadsheetValues` operation uses the existing extraction admission queues
and isolated child process. It refuses `EXTRACTION_ISOLATION=off`, limits input
before IPC, caps parsing at 15 seconds and checks full structured output size in
child and parent. Source metadata/read waits are bounded separately at 15 seconds;
late metadata completion cannot start a stream after cancellation/deadline.

Existing isolation uses Linux process/data/address-space limits and stripped
child environment. On other platforms only the existing process/heap/input/
output/deadline protections apply. This is **not** a filesystem/network sandbox,
a malformed-file fuzz certification or a guarantee that every upstream storage
transport operation can be physically cancelled. No new dependency is added.

## Synthetic verification

Fixtures and generator live in
`backend/src/lib/__tests__/fixtures/spreadsheetValues/`. They are original
AI-generated synthetic data, not client files or SME-reviewed samples. The
manifest records hashes, purposes and expected admission outcomes.

The formula fixture has genuine BIFF8 cached numeric and blank results. BIFF8
requires a cache representation; the deliberately absent mandatory String
record is rejected as malformed. It is not claimed as a valid missing-cache
example. Encryption and chart/macro rejection fixtures mark those record types;
they do not qualify decryption or real macro execution.

```sh
npm test --prefix backend -- src/lib/__tests__/spreadsheetValues.test.ts src/lib/extraction/__tests__/spreadsheetValues.test.ts src/modules/documents/__tests__/documents.spreadsheetValues.test.ts src/__tests__/integration/documents.spreadsheetValues.routes.test.ts
npm test --prefix frontend -- src/app/components/shared/views/SpreadsheetValuesView.test.tsx src/app/components/shared/views/SpreadsheetView.session.test.tsx src/app/components/shared/views/SpreadsheetView.sources.test.tsx
```

Tests exercise pure decoding, real child IPC/failure recovery, exact-version
and digest checks, in-memory access changes, bounded reads, strict HTTP query
contracts, client error classification, cancellation/navigation, escaped text,
cached/blank/missing labels, sheet navigation, pagination and checkpoint downloads.
Full authenticated-stack and diverse Excel-producer qualification remain distinct
from these tests and must not be implied by their counts.

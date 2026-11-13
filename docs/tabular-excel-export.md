# Tabular review Excel handover (local prototype)

Export keeps the existing **Review** worksheet, answer formatting, row order and
column order. It exports all supplied review rows, not just search results or
selected rows. **Evidence**, the second worksheet, contains supporting information
from the same snapshot; it does not independently verify an answer or its sources.

Each answer has one Evidence record per recognized summary citation, in citation
order, or one record if no citation is recognized. **Answer address** identifies
the corresponding Review cell. Row/column IDs and indexes distinguish duplicate
labels. **Record** distinguishes an absent cell from a stored cell; **Stored
status** preserves `pending`, `generating`, `error` or `done` without inventing a
status for absent cells. A completed empty answer is therefore different from an
unfinished or missing answer. Content presence, flag, reasoning, raw summary,
cell document ID and ordered row source IDs (JSON) are also retained. A flag is
not a confidence or verification score.

Citation fields preserve the existing parser's quotation and available page,
sheet and cell/row-column location. Filenames come only from supplied document
metadata. An explicit citation document ID is retained even if its metadata is
missing. A citation with no ID can use the row's sole source ID, labelled as an
inference; multi-source and empty-source rows remain explicitly unresolved.
Row source membership alone is not proof of support. Duplicate filenames do not
merge sources. No extra document metadata is fetched.

All exported values are text or numbers, never executable formula objects.
Exports exceeding 32,767 UTF-16 units in a cell, 1,048,576 worksheet rows
(including headers and expanded citations), or 16,384 columns are refused before
download with an explicit notice rather than silently truncated. Shorten the
content or use a smaller review before retrying; no continuation sheets or
background export service are introduced.

Limitations: this is a proposed local format, not maintainer-agreed issue closure.
Only summary citations recognized by the existing `preprocessCitations` helper
get citation records. Unsupported/malformed legacy markers remain in **Raw
summary**; reasoning is retained as text, not parsed for citations. Parser
normalization (including trimming quotations) still applies. The workbook does
not preserve source document bytes, version guarantees or unsupported separate
legacy citation payloads. It is not a signed or tamper-evident export.

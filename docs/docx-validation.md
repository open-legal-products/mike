# DOCX upload validation

Sealed DOCX uploads are checked before destination storage copies, conversion,
or document/version writes. The checks cover required package parts, the main
Word relationship, content type, document/body namespace identity, XML syntax,
DTD rejection, fatal BOM-aware UTF-8/UTF-16 decoding, and declared/actual byte
ceilings. They are not full OOXML schema validation.

Validation uses the existing `validateDocxPackage` extraction operation. With
isolation enabled, ZIP decompression and full-tree XML parsing run in the existing
separate parser process under its existing admission, deadline, heap and platform
limits. Uploads acquire the parser slot before reading the archive into memory.
No extraction configuration or upload/package ceilings are changed.

- Invalid packages fail terminally as `invalid_docx_package` before destination
  side effects. Validation deadline/memory failures are a distinct terminal
  `document_too_large` outcome, not a claim of malformed XML.
- A busy parser is not a failure: the upload waits up to 60 s for the slot,
  then is requeued 30 s later without spending a retry attempt or reporting
  an error (the same bounds as the background text jobs). Like those jobs,
  uploads pass through the background admission gate first, so only one
  upload at a time occupies a place in the parser's own queue and a batch of
  uploads cannot fill it and turn away interactive parses. That one upload
  holds its bytes while it waits for the parser; the others hold nothing.
- Unexpected process/I/O failures remain retryable through the existing
  bounded upload retry policy. A terminal validation failure runs the same
  destination-document cleanup as any other upload failure: a document row
  an earlier attempt of the job created (and whose worker was then lost) is
  marked failed and removed rather than left `processing`. Temporary
  sealed-file artifacts are still removed.
- `EXTRACTION_ISOLATION=off` retains the existing in-process fallback and provides
  **no containment guarantee**. Non-Linux platforms retain separate-process,
  heap, deadline and input/output bounds, but not Linux's native-memory limit.
- This is containment, **not streaming or constant-memory parsing**. The child
  still builds complete XML strings/trees; compressed data remains in the parent
  and is copied for IPC. Resource budgets can reject expensive valid files.
  No resource reduction or responsiveness improvement has been measured.

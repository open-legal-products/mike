import { describe, expect, it } from "vitest";
import { duplicateReadDocumentResult } from "./documentOps";

describe("duplicateReadDocumentResult", () => {
  const parsed = () =>
    JSON.parse(
      duplicateReadDocumentResult({
        docLabel: "doc-2",
        documentId: "abc",
        versionId: "v1",
      }),
    ) as Record<string, unknown>;

  it("carries no content key", () => {
    // The regression this guards: prose in "content" — where document text
    // belongs — read as a malfunction. Models re-called read_document, got
    // the same sentence, and looped until the step cap ended the turn with no
    // answer. One measured turn read a single file 29 times this way.
    expect(parsed()).not.toHaveProperty("content");
  });

  it("says retrying cannot help, which is what breaks the loop", () => {
    const result = parsed();
    expect(String(result.explanation)).toMatch(/not a truncation/i);
    expect(String(result.next_required_action)).toMatch(
      /Do NOT call read_document for this document again/,
    );
  });

  it("still identifies the document it is standing in for", () => {
    expect(parsed()).toMatchObject({
      ok: true,
      already_read: true,
      doc_id: "doc-2",
      document_id: "abc",
      version_id: "v1",
    });
  });
});

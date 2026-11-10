import { afterEach, expect, it, vi } from "vitest";
import type { DocStore } from "../../types";
import { findInDocumentContent } from "../documentOps";

afterEach(() => vi.restoreAllMocks());

it("normalizes a document once across many find_in_document probes", async () => {
  const text = "The Supplier shall indemnify the Buyer. ".repeat(250); // 10k chars
  const docStore: DocStore = new Map([
    ["D1", { storage_path: "", filename: "msa.docx", file_type: "docx", inline_text: text }],
  ]);
  // normalizeWithMap runs one whitespace regex test per character.
  const regexTests = vi.spyOn(RegExp.prototype, "test");
  for (const query of ["supplier", "indemnify", "buyer", "the", "shall"]) {
    const result = JSON.parse(
      await findInDocumentContent({ docLabel: "D1", query, docStore, write: () => {} }),
    );
    expect(result.total_matches).toBe(query === "the" ? 500 : 250);
  }
  expect(regexTests.mock.calls.length).toBeLessThan(text.length * 1.5);
});

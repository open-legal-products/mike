import { describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import type { DbJob } from "../../../lib/dbq/types";
import { readEmbeddingConfig } from "../../../lib/rag/embeddingClient";
import { handleDocumentEmbedText, markDocumentEmbeddingsFailed } from "../documents.embeddings";

const cfg = readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "bge-m3" });
const job = { id: "job", kind: "document.embed_text", payload: { versionId: "v1", revision: "r1", model: "bge-m3" },
  status: "running", attempts: 1, max_attempts: 3, run_at: "", claimed_at: null, finished_at: null,
  last_error: null, dedupe_key: null, result: null, created_at: "" } satisfies DbJob;

describe("document.embed_text", () => {
  it("chunks the revision's text, embeds it and replaces the chunk index", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })));
    const fake = scriptedDb([
      { table: "document_embedding_status", op: "update", data: { version_id: "v1" } },
      { table: "document_version_texts", data: { text_content: "[Page 1]\nClausola compromissoria." } },
      { rpc: "replace_document_text_chunks", data: true },
    ]);
    await handleDocumentEmbedText(fake.db, job, cfg, fetchMock as unknown as typeof fetch);
    expect(fake.calls[2].args).toMatchObject({ p_version_id: "v1", p_revision: "r1", p_model: "bge-m3",
      p_chunks: [{ chunk_index: 0, page_start: 1, page_end: 1, content: "Clausola compromissoria.", embedding: "[0.1,0.2]" }] });
    fake.done();
  });
  it("is a no-op when RAG is off or the configured model changed", async () => {
    const fake = scriptedDb([]);
    await handleDocumentEmbedText(fake.db, job, readEmbeddingConfig({}));
    await handleDocumentEmbedText(fake.db, job, { ...cfg, model: "other", indexKey: "other" });
    fake.done();
  });
  it("marks exhausted work failed for its exact revision and model", async () => {
    const fake = scriptedDb([{ table: "document_embedding_status", op: "update" }]);
    await markDocumentEmbeddingsFailed(fake.db, job);
    expect(fake.calls[0].filters).toEqual(expect.arrayContaining([["eq", "source_revision", "r1"], ["eq", "embedding_model", "bge-m3"]]));
    fake.done();
  });
});

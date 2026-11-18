import { describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import type { DbJob } from "../../../lib/dbq/types";
import { readEmbeddingConfig } from "../../../lib/rag/embeddingClient";
import {
  backfillDocumentEmbeddings,
  handleDocumentEmbedText,
  markDocumentEmbeddingsFailed,
  queueDocumentEmbeddings,
} from "../documents.embeddings";
import { searchDocumentsSemantic } from "../documents.semanticSearch";

const cfg = readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "bge-m3" });
const job = { id: "job", kind: "document.embed_text", payload: { versionId: "v1", revision: "r1", model: "bge-m3" },
  status: "running", attempts: 1, max_attempts: 3, run_at: "", claimed_at: null, finished_at: null,
  last_error: null, dedupe_key: null, result: null, created_at: "" } satisfies DbJob;

describe("document.embed_text", () => {
  it("chunks the revision's text, embeds it with the configured provider and replaces the chunk index", async () => {
    const mistralCfg = readEmbeddingConfig({
      RAG_ENABLED: "true",
      EMBEDDING_PROVIDER: "mistral",
      MISTRAL_API_KEY: "m-secret",
      OPENAI_API_KEY: "other-secret",
    });
    const mistralJob = { ...job, payload: { versionId: "v1", revision: "r1", model: mistralCfg.indexKey } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })));
    const fake = scriptedDb([
      { table: "document_embedding_status", op: "update", data: { version_id: "v1" } },
      { table: "document_version_texts", data: { text_content: "[Page 1]\nClausola compromissoria." } },
      { rpc: "replace_document_text_chunks", data: true },
    ]);
    await handleDocumentEmbedText(fake.db, mistralJob, mistralCfg, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.mistral.ai/v1/embeddings");
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer m-secret");
    expect(fake.calls[2].args).toMatchObject({ p_version_id: "v1", p_revision: "r1", p_model: "mistral-embed",
      p_chunks: [{ chunk_index: 0, page_start: 1, page_end: 1, content: "Clausola compromissoria.", embedding: "[0.1,0.2]" }] });
    fake.done();
  });
  it("hands the claim back and never calls the embedding provider when the revision text was removed", async () => {
    const fetchMock = vi.fn();
    const fake = scriptedDb([
      { table: "document_embedding_status", op: "update", data: { version_id: "v1" } },
      { table: "document_version_texts", data: null },
      { table: "document_embedding_status", op: "update" },
    ]);
    await handleDocumentEmbedText(fake.db, job, cfg, fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.calls[2].payload).toMatchObject({ status: "pending" });
    expect(fake.calls[2].filters).toEqual(expect.arrayContaining([["eq", "status", "processing"], ["eq", "source_revision", "r1"]]));
    fake.done();
  });
  it("does not call the embedding provider when the source version was deleted and its status row was cleaned up", async () => {
    const fetchMock = vi.fn();
    const fake = scriptedDb([
      { table: "document_embedding_status", op: "update", data: null },
    ]);
    await handleDocumentEmbedText(fake.db, job, cfg, fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    fake.done();
  });
  it("is a no-op when RAG is off, configuration is incomplete, or the configured model changed", async () => {
    const fetchMock = vi.fn();
    const fake = scriptedDb([]);
    const incompleteOpenAi = readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "openai" });
    const incompleteAzure = readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "azure", AZURE_API_KEY: "az" });
    expect(incompleteOpenAi.enabled).toBe(false);
    expect(incompleteAzure.enabled).toBe(false);
    await handleDocumentEmbedText(fake.db, job, readEmbeddingConfig({}), fetchMock as unknown as typeof fetch);
    await handleDocumentEmbedText(fake.db, job, incompleteOpenAi, fetchMock as unknown as typeof fetch);
    await handleDocumentEmbedText(fake.db, job, incompleteAzure, fetchMock as unknown as typeof fetch);
    await handleDocumentEmbedText(fake.db, job, { ...cfg, model: "other", indexKey: "other" }, fetchMock as unknown as typeof fetch);
    await queueDocumentEmbeddings(fake.db, "v1", incompleteOpenAi);
    expect(await backfillDocumentEmbeddings(fake.db, {}, incompleteAzure)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    fake.done();
  });
  it("marks exhausted work failed for its exact revision and model", async () => {
    const fake = scriptedDb([{ table: "document_embedding_status", op: "update" }]);
    await markDocumentEmbeddingsFailed(fake.db, job);
    expect(fake.calls[0].filters).toEqual(expect.arrayContaining([["eq", "source_revision", "r1"], ["eq", "embedding_model", "bge-m3"]]));
    fake.done();
  });
  it("routes query embeddings only to the configured provider and refuses incomplete configurations in searchDocumentsSemantic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.5, 0.5] }] })));
    const incompleteCfg = readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "azure", AZURE_API_KEY: "az" });
    const offResult = await searchDocumentsSemantic({} as never, {
      userId: "u1", scope: "library", query: "clausola compromissoria",
    }, incompleteCfg, fetchMock as unknown as typeof fetch);
    expect(offResult).toMatchObject({ ok: false, kind: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();

    const azureCfg = readEmbeddingConfig({
      RAG_ENABLED: "true",
      EMBEDDING_PROVIDER: "azure",
      EMBEDDING_API_URL: "https://firm.openai.azure.com/openai/deployments/emb/embeddings?api-version=2024-10-21",
      AZURE_API_KEY: "az-key",
      OPENAI_API_KEY: "do-not-send",
    });
    const fake = scriptedDb([
      { rpc: "search_document_chunks", data: { coverage: { total_versions: 1, embedded_versions: 1 }, matches: [] } },
    ]);
    const okResult = await searchDocumentsSemantic(fake.db, {
      userId: "u1", scope: "library", query: "clausola compromissoria",
    }, azureCfg, fetchMock as unknown as typeof fetch);
    expect(okResult).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://firm.openai.azure.com/openai/deployments/emb/embeddings?api-version=2024-10-21");
    expect(fetchMock.mock.calls[0]![1].headers["api-key"]).toBe("az-key");
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBeUndefined();
    fake.done();
  });
  it("fails when replace_document_text_chunks returns false because the text row was deleted mid-flight", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })));
    const fake = scriptedDb([
      { table: "document_embedding_status", op: "update", data: { version_id: "v1" } },
      { table: "document_version_texts", data: { text_content: "[Page 1]\nClausola." } },
      { rpc: "replace_document_text_chunks", data: false },
    ]);
    await expect(handleDocumentEmbedText(fake.db, job, cfg, fetchMock as unknown as typeof fetch)).rejects.toMatchObject({
      kind: "rag.replace_rejected",
    });
    fake.done();
  });
});

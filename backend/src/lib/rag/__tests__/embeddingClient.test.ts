import { describe, expect, it, vi } from "vitest";
import { buildEmbeddingHeaders, embedDocuments, embedQuery, readEmbeddingConfig, toVectorLiteral } from "../embeddingClient";

const response = (vectors: number[][], status = 200) => new Response(
  JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }),
  { status, headers: { "Content-Type": "application/json" } },
);

describe("embedding configuration", () => {
  it("is off unless RAG_ENABLED=true", () => {
    expect(readEmbeddingConfig({ OPENAI_API_KEY: "k" }).enabled).toBe(false);
    expect(readEmbeddingConfig({ RAG_ENABLED: "true", OPENAI_API_KEY: "k" }).enabled).toBe(true);
  });
  it("supports keyless local Ollama and a custom gateway with its own header", () => {
    const local = readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "bge-m3" });
    expect(local.url).toBe("http://localhost:11434/v1/embeddings");
    expect(local.enabled).toBe(true);
    const custom = readEmbeddingConfig({
      RAG_ENABLED: "true", EMBEDDING_BASE_URL: "https://tei.internal/v1", EMBEDDING_MODEL: "intfloat/multilingual-e5-large",
      EMBEDDING_API_KEY: "secret", EMBEDDING_AUTH_HEADER: "api-key",
    });
    expect(custom.url).toBe("https://tei.internal/v1/embeddings");
    expect(buildEmbeddingHeaders(custom)).toMatchObject({ "api-key": "secret" });
  });
  it("never sends a provider deployment key to an unrelated custom host", () => {
    const cfg = readEmbeddingConfig({
      RAG_ENABLED: "true", EMBEDDING_PROVIDER: "openai", EMBEDDING_API_URL: "https://other.example.com/v1/embeddings",
      OPENAI_API_KEY: "sk-do-not-leak",
    });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.enabled).toBe(false);
  });
});

describe("embedding requests", () => {
  const cfg = readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "mistral", MISTRAL_API_KEY: "m", EMBEDDING_BATCH_SIZE: "2", EMBEDDING_QUERY_PREFIX: "query: " });
  it("batches documents and keeps input order", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([[1, 0], [0, 1]]))
      .mockResolvedValueOnce(response([[1, 1]]));
    const out = await embedDocuments(["a", "b", "c"], cfg, fetchMock as unknown as typeof fetch);
    expect(out).toEqual([[1, 0], [0, 1], [1, 1]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.mistral.ai/v1/embeddings");
  });
  it("applies the query prefix and rejects malformed vectors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response([[0.5, 0.5]]));
    await embedQuery("clausola", cfg, fetchMock as unknown as typeof fetch);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).input).toEqual(["query: clausola"]);
    const bad = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: ["x"] }] })));
    await expect(embedQuery("q", cfg, bad as unknown as typeof fetch)).rejects.toMatchObject({ kind: "rag.embedding_invalid_response" });
  });
  it("formats pgvector literals", () => {
    expect(toVectorLiteral([0.1, -2, 3])).toBe("[0.1,-2,3]");
  });
});

describe("embedding review hardening", () => {
  it("includes the configured dimensions in the index key", () => {
    expect(readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "m" } as never).indexKey).toBe("m");
    expect(readEmbeddingConfig({
      RAG_ENABLED: "true", EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "m", EMBEDDING_DIMENSIONS: "512",
    } as never).indexKey).toBe("m@512");
  });

  it("falls back when a size rounds below one", () => {
    expect(readEmbeddingConfig({ EMBEDDING_BATCH_SIZE: "0.5" } as never).batchSize).toBe(32);
  });

  it("sends deployment keys only to the provider's own host", () => {
    const lookalike = readEmbeddingConfig({
      EMBEDDING_PROVIDER: "mistral", EMBEDDING_API_URL: "https://notmistral.ai/v1/embeddings", MISTRAL_API_KEY: "k",
    } as never);
    expect(lookalike.apiKey).toBeUndefined();
    const mistral = readEmbeddingConfig({ EMBEDDING_PROVIDER: "mistral", MISTRAL_API_KEY: "k" } as never);
    expect(mistral.apiKey).toBe("k");
    const azureForeign = readEmbeddingConfig({
      EMBEDDING_PROVIDER: "azure", EMBEDDING_API_URL: "https://gateway.example.test/v1/embeddings", AZURE_API_KEY: "a",
    } as never);
    expect(azureForeign.apiKey).toBeUndefined();
  });

  it("rejects duplicate response indices", async () => {
    const cfg = readEmbeddingConfig({ RAG_ENABLED: "true", EMBEDDING_PROVIDER: "ollama" } as never);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [3, 4] }],
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(embedDocuments(["a", "b"], cfg, fetchImpl)).rejects.toMatchObject({ kind: "rag.embedding_invalid_response" });
  });
});

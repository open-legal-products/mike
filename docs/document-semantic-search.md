# Semantic document search (optional RAG)

Mike's literal search (`find_documents`, see `document-text-search.md`) finds
exact phrases. This optional layer adds meaning-based retrieval over the same
stored text, including text recognized by OCR. It is **off by default** and
needs no extra service beyond Postgres with the `pgvector` extension and an
embedding endpoint.

## How it works

1. `document.extract_text` publishes a version's text (unchanged behaviour).
2. With `RAG_ENABLED=true`, the worker then calls `queue_document_embeddings`,
   which enqueues `document.embed_text` for that exact text revision and model.
3. The job splits the text into page-aware, overlapping chunks
   (`lib/rag/chunking.ts`, `RAG_CHUNK_CHARS` / `RAG_CHUNK_OVERLAP`), embeds them
   in batches (`lib/rag/embeddingClient.ts`) and calls
   `replace_document_text_chunks`, which only writes while the version's
   `text_revision` still matches. Late jobs cannot publish vectors of an
   edited, deleted or superseded text.
4. The assistant tool `search_documents_semantic` embeds the question and calls
   `search_document_chunks`: vector similarity (cosine) and Postgres full-text
   ranking (`simple` configuration, language-neutral) are fused with Reciprocal
   Rank Fusion. Scopes and permission checks are those of `find_document_text`
   (workspace, project role, `document_text_access`); only current versions and
   only chunks of the current revision and configured model are searched.
5. Hits return passages with page range and offsets plus revision-pinned
   `doc_id` handles, so the model reads and cites the full text through the
   existing `read_document` / `find_in_document` path.

## Configuration

See the `RAG_*` and `EMBEDDING_*` entries in `backend/.env.example`. Any
OpenAI-compatible `/v1/embeddings` endpoint works. For confidential matters a
local endpoint (Ollama with `bge-m3`, or TEI/vLLM with a multilingual model)
keeps document text on the firm's infrastructure. Models such as e5 need
`EMBEDDING_QUERY_PREFIX="query: "` and `EMBEDDING_DOCUMENT_PREFIX="passage: "`.

Changing `EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS` does not mix vectors: rows
are keyed by the embedding space (`<model>`, or `<model>@<dimensions>` when
`EMBEDDING_DIMENSIONS` is set), the search reads only the configured key, and it
also skips any vector whose size differs from the query's. Run the backfill to
embed existing documents in the new space; rows of the old key are ignored and can
be deleted with `delete from public.document_text_chunks where embedding_model='<old key>'`.
Embedding work left pending (for example a job that ran while RAG was disabled) is
requeued by the same backfill. Embedding credentials follow the OCR rule: a
provider key is sent only to that provider's own host.

## Rollout

1. Enable `pgvector` on the database (Supabase: Database → Extensions).
2. Apply `20261114_01_document_semantic_search.sql`.
3. Set `RAG_ENABLED=true` and the embedding variables; deploy backend and worker.
4. Embed existing documents in bounded batches (up to 500 per call) with
   `backfillDocumentEmbeddings(db, { limit, retryFailed })` from the documents
   facade, or `select public.backfill_document_embeddings('<index key>', 500);`.

## Scale

Searches compute exact distance over the caller's eligible versions, which is
adequate for matter- and library-sized corpora. A deployment that fixes its
dimension can add an approximate index, for example for 1024 dimensions:

```sql
create index document_text_chunks_hnsw_1024 on public.document_text_chunks
  using hnsw ((embedding::vector(1024)) vector_cosine_ops)
  where embedding_model = 'bge-m3';
```

(the search query must then cast `embedding::vector(1024)` to use it).

## Limits and notes

- Results are ranked, not exhaustive; the tool description tells the model to
  verify passages by reading them and not to infer absence.
- Chunk offsets are JavaScript (UTF-16) offsets into the stored text; the
  literal search reports Unicode code-point offsets.
- Embedding failures never fail text extraction: queueing is best effort and
  the job's 4xx answers (bad key, unknown model) stop without retries.

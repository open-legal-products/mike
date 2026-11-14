import { AppError } from "../appError";

/**
 * Configurable embedding client for optional semantic retrieval (RAG) over
 * stored document text.
 *
 * Speaks the OpenAI-compatible `POST /v1/embeddings` protocol, which is served
 * by OpenAI, Azure OpenAI, Mistral (`mistral-embed`), Ollama, vLLM, LiteLLM,
 * Text Embeddings Inference (TEI) and most self-hosted gateways.
 *
 * Shared kernel (`lib/`): never imports `modules/` or `application/`.
 * Credential rules mirror `lib/ocr/ocrClient.ts`: a dedicated key or an
 * explicitly named environment variable is always honoured; a provider's
 * deployment key is reused only for that provider's own host, never for an
 * unrelated custom endpoint. Loopback endpoints may run without a key.
 * Errors carry static `AppError` kinds and never include document text,
 * filenames, URLs or upstream bodies.
 *
 * RAG is strictly opt-in: nothing is embedded unless RAG_ENABLED=true.
 */

export type EmbeddingProvider = "openai" | "mistral" | "ollama" | "azure" | "custom";

export type EmbeddingConfig = {
  enabled: boolean;
  provider: EmbeddingProvider;
  url: string;
  apiKey?: string;
  model: string;
  dimensions?: number;
  /**
   * Embedding-space identity stored with every chunk and status row and used
   * by the queue, backfill and search: the model, plus `@<dimensions>` when
   * EMBEDDING_DIMENSIONS is set. Changing either yields a new key, so stale
   * vectors are never compared with new ones and backfill re-embeds.
   */
  indexKey: string;
  authHeader: string;
  authScheme: string;
  extraHeaders: Record<string, string>;
  allowUnauthenticated: boolean;
  batchSize: number;
  timeoutMs: number;
  queryPrefix: string;
  documentPrefix: string;
  chunkChars: number;
  chunkOverlap: number;
  maxChunksPerVersion: number;
};

const DEFAULTS: Record<EmbeddingProvider, { url: string; model: string }> = {
  openai: { url: "https://api.openai.com/v1/embeddings", model: "text-embedding-3-small" },
  mistral: { url: "https://api.mistral.ai/v1/embeddings", model: "mistral-embed" },
  ollama: { url: "http://localhost:11434/v1/embeddings", model: "bge-m3" },
  azure: { url: "", model: "text-embedding-3-small" },
  custom: { url: "", model: "" },
};

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
}

function normalizeProvider(raw: string | undefined): EmbeddingProvider | undefined {
  const v = raw?.trim().toLowerCase();
  return v === "openai" || v === "mistral" || v === "ollama" || v === "azure" || v === "custom" ? v : undefined;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function isLoopback(url: string): boolean {
  const h = hostOf(url);
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function embeddingsUrlFromBase(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/embeddings")) return trimmed;
  if (trimmed.endsWith("/v1") || trimmed.endsWith("/openai")) return `${trimmed}/embeddings`;
  return `${trimmed}/v1/embeddings`;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k.trim() && typeof v === "string") out[k.trim()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function resolveKey(env: NodeJS.ProcessEnv, provider: EmbeddingProvider, url: string, custom: boolean): string | undefined {
  const direct = env.EMBEDDING_API_KEY?.trim();
  if (direct) return direct;
  const named = env.EMBEDDING_API_KEY_ENV?.trim();
  if (named) {
    const value = env[named]?.trim();
    if (value) return value;
  }
  // A provider's deployment key is sent only to that provider's own host
  // (exact host or a dot-delimited subdomain); any other endpoint needs
  // EMBEDDING_API_KEY or EMBEDDING_API_KEY_ENV.
  void custom;
  const host = hostOf(url);
  const within = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  switch (provider) {
    case "openai":
      return host === "api.openai.com" ? env.OPENAI_API_KEY?.trim() || undefined : undefined;
    case "mistral":
      return within("mistral.ai") ? env.MISTRAL_API_KEY?.trim() || undefined : undefined;
    case "ollama": {
      const ollamaHost = hostOf(env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1");
      return within("ollama.com") || host === ollamaHost ? env.OLLAMA_API_KEY?.trim() || undefined : undefined;
    }
    case "azure":
      return within("openai.azure.com") || within("cognitiveservices.azure.com") || within("services.ai.azure.com")
        ? env.AZURE_API_KEY?.trim() || undefined
        : undefined;
    default:
      return undefined;
  }
}

export function readEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const explicitUrl = env.EMBEDDING_API_URL?.trim() || undefined;
  const explicitBase = env.EMBEDDING_BASE_URL?.trim() || undefined;
  const custom = Boolean(explicitUrl || explicitBase);
  const provider = normalizeProvider(env.EMBEDDING_PROVIDER) ?? (custom ? "custom" : "openai");

  let url: string;
  if (explicitUrl) url = explicitUrl;
  else if (explicitBase) url = embeddingsUrlFromBase(explicitBase);
  else if (provider === "ollama" && env.OLLAMA_BASE_URL?.trim()) url = embeddingsUrlFromBase(env.OLLAMA_BASE_URL);
  else url = DEFAULTS[provider].url;

  const authHeader = env.EMBEDDING_AUTH_HEADER?.trim() || (provider === "azure" ? "api-key" : "Authorization");
  const authScheme = env.EMBEDDING_AUTH_SCHEME !== undefined
    ? env.EMBEDDING_AUTH_SCHEME.trim()
    : authHeader.toLowerCase() === "authorization" ? "Bearer" : "";

  const allowEnv = env.EMBEDDING_ALLOW_UNAUTHENTICATED?.trim().toLowerCase();
  const allowUnauthenticated = allowEnv === "true" ? true : allowEnv === "false" ? false
    : provider === "ollama" || (Boolean(url) && isLoopback(url));

  const dims = Number(env.EMBEDDING_DIMENSIONS);
  const chunkChars = positiveInt(env.RAG_CHUNK_CHARS, 1800, 8000);
  const chunkOverlap = Math.min(positiveInt(env.RAG_CHUNK_OVERLAP, 200, 2000), Math.floor(chunkChars / 2));

  const model = env.EMBEDDING_MODEL?.trim() || DEFAULTS[provider].model;
  const apiKey = url ? resolveKey(env, provider, url, custom) : undefined;
  const dimensions = Number.isInteger(dims) && dims > 0 ? dims : undefined;

  return {
    enabled: env.RAG_ENABLED === "true" && Boolean(url) && Boolean(model) && (Boolean(apiKey) || allowUnauthenticated),
    provider,
    url,
    apiKey,
    model,
    dimensions,
    indexKey: dimensions ? `${model}@${dimensions}` : model,
    authHeader,
    authScheme,
    extraHeaders: parseHeaders(env.EMBEDDING_EXTRA_HEADERS_JSON),
    allowUnauthenticated,
    batchSize: positiveInt(env.EMBEDDING_BATCH_SIZE, 32, 256),
    timeoutMs: positiveInt(env.EMBEDDING_TIMEOUT_MS, 60_000),
    queryPrefix: env.EMBEDDING_QUERY_PREFIX ?? "",
    documentPrefix: env.EMBEDDING_DOCUMENT_PREFIX ?? "",
    chunkChars,
    chunkOverlap,
    maxChunksPerVersion: positiveInt(env.RAG_MAX_CHUNKS_PER_VERSION, 3000),
  };
}

export function ragEnabled(cfg: EmbeddingConfig = readEmbeddingConfig()): boolean {
  return cfg.enabled;
}

export function buildEmbeddingHeaders(cfg: EmbeddingConfig): Record<string, string> {
  const headers: Record<string, string> = { ...cfg.extraHeaders, "Content-Type": "application/json" };
  if (cfg.apiKey) headers[cfg.authHeader] = cfg.authScheme ? `${cfg.authScheme} ${cfg.apiKey}` : cfg.apiKey;
  return headers;
}

type EmbeddingsWire = { data?: Array<{ index?: unknown; embedding?: unknown }> };

async function embedBatch(inputs: string[], cfg: EmbeddingConfig, fetchImpl: typeof fetch): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(cfg.url, {
        method: "POST",
        signal: controller.signal,
        headers: buildEmbeddingHeaders(cfg),
        body: JSON.stringify({
          model: cfg.model,
          input: inputs,
          ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
        }),
      });
    } catch (cause) {
      throw new AppError(
        controller.signal.aborted ? "rag.embedding_timeout" : "rag.embedding_network_failed",
        controller.signal.aborted ? "Embedding request timed out" : "Embedding request failed",
        { cause },
      );
    }
    if (!response.ok) {
      throw new AppError("rag.embedding_http_failed", "Embedding endpoint returned an error status", {
        cause: Object.assign(new Error("Embedding HTTP failure"), { status: response.status }),
      });
    }
    let body: EmbeddingsWire;
    try {
      body = (await response.json()) as EmbeddingsWire;
    } catch (cause) {
      throw new AppError("rag.embedding_invalid_response", "Embedding endpoint returned non-JSON body", { cause });
    }
    if (!Array.isArray(body?.data) || body.data.length !== inputs.length) {
      throw new AppError("rag.embedding_invalid_response", "Embedding response size mismatch");
    }
    const out: number[][] = new Array(inputs.length);
    const seen = new Set<number>();
    body.data.forEach((item, position) => {
      const index = typeof item?.index === "number" && Number.isInteger(item.index) ? item.index : position;
      if (index < 0 || index >= inputs.length || seen.has(index)) {
        throw new AppError("rag.embedding_invalid_response", "Embedding response has a duplicate or out-of-range index");
      }
      seen.add(index);
      const vector = item?.embedding;
      if (!Array.isArray(vector) || vector.length === 0 || !vector.every((n) => typeof n === "number" && Number.isFinite(n))) {
        throw new AppError("rag.embedding_invalid_response", "Embedding response contains an invalid vector");
      }
      out[index] = vector as number[];
    });
    const dims = out[0]?.length;
    // Array.prototype.some skips holes, so check every slot explicitly.
    if (seen.size !== inputs.length || Array.from(out, (v) => !v || v.length !== dims).some(Boolean)) {
      throw new AppError("rag.embedding_invalid_response", "Embedding vectors have inconsistent dimensions");
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** Embed document chunks in bounded batches, applying the document prefix. */
export async function embedDocuments(
  texts: readonly string[],
  cfg: EmbeddingConfig = readEmbeddingConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += cfg.batchSize) {
    const batch = texts.slice(i, i + cfg.batchSize).map((t) => cfg.documentPrefix + t);
    out.push(...(await embedBatch(batch, cfg, fetchImpl)));
  }
  return out;
}

/** Embed a single search query, applying the query prefix (e.g. "query: " for e5). */
export async function embedQuery(
  query: string,
  cfg: EmbeddingConfig = readEmbeddingConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<number[]> {
  const [vector] = await embedBatch([cfg.queryPrefix + query], cfg, fetchImpl);
  return vector!;
}

/** pgvector text literal: "[0.1,0.2,...]". */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

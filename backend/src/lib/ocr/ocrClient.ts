import { AppError } from "../appError";

/**
 * Configurable OCR client for scanned PDF pages and raster images.
 *
 * Supports two wire protocols:
 * 1. `mistral-ocr` (`POST /v1/ocr`): Mistral Document AI, Azure AI Foundry
 *    Mistral OCR deployments, and compatible `/v1/ocr` servers.
 * 2. `openai-chat` (`POST /v1/chat/completions`): OpenAI-compatible Vision /
 *    multimodal endpoints including Ollama, vLLM, LiteLLM, OpenRouter, OpenAI,
 *    and Azure OpenAI.
 *
 * Lives in the shared kernel (`lib/`): never imports from `modules/` or
 * `application/`. Called from `modules/documents/documents.indexing.ts` in the
 * worker/API process after the isolated child parser (`pdf.js`) has identified
 * whether any pages lack a text layer. The child parser itself stays secret-free
 * and network-free.
 *
 * Credential & privacy boundaries:
 * - Dedicated `OCR_API_KEY` or `OCR_API_KEY_ENV` is preferred.
 * - Provider-specific environment fallbacks (`MISTRAL_API_KEY`, `OPENAI_API_KEY`,
 *   `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`, `AZURE_FOUNDRY_API_KEY`, `AZURE_API_KEY`)
 *   are only used when the target provider/host matches, preventing a deployment
 *   key for one provider from being sent to an unrelated custom host.
 * - Loopback/local endpoints (`localhost`, `127.0.0.1`, `::1`) or explicit
 *   `OCR_ALLOW_UNAUTHENTICATED=true` can run without an API key (e.g. local Ollama/vLLM).
 * - Diagnostic errors use static `AppError` kinds and never include document
 *   text, filenames, URLs, or upstream response bodies.
 */

export type OcrProtocol = "mistral-ocr" | "openai-chat";

export type OcrProviderPreset =
  | "mistral"
  | "openai"
  | "openai-compatible"
  | "ollama"
  | "vllm"
  | "litellm"
  | "openrouter"
  | "azure"
  | "azure-foundry"
  | "custom";

export type OcrOpenAiPdfPartMode = "file" | "image_url" | "document_url";

export type OcrConfig = {
  provider: OcrProviderPreset;
  protocol: OcrProtocol;
  apiKey?: string;
  url: string;
  model: string;
  authHeader: string;
  authScheme: string;
  extraHeaders: Record<string, string>;
  allowUnauthenticated: boolean;
  prompt: string;
  openAiPdfPart: OcrOpenAiPdfPartMode;
  minPageChars: number;
  timeoutMs: number;
  maxBytes: number;
  disabled: boolean;
};

export type OcrPage = {
  index: number;
  text: string;
};

export type ExtractedPdfIndexText = {
  text: string;
  textlessPageCount: number | null;
};

export type EnrichedPdfIndexText = {
  text: string;
  textlessPageCount: number | null;
  ocrPageCount: number;
  error?: AppError;
};

const DEFAULT_MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr";
const DEFAULT_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

const DEFAULT_MISTRAL_OCR_MODEL = "mistral-ocr-latest";
const DEFAULT_OPENAI_OCR_MODEL = "gpt-4.1-mini";
const DEFAULT_OLLAMA_OCR_MODEL = "qwen2.5vl:7b";
const DEFAULT_OPENROUTER_OCR_MODEL = "qwen/qwen2.5-vl-72b-instruct";

const DEFAULT_MIN_PAGE_CHARS = 25;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

const DEFAULT_OCR_PROMPT =
  "Transcribe all visible text from the document into Markdown. " +
  "Preserve headings, article and clause numbering, tables (as Markdown tables), " +
  "dates, party names, stamps, signatures, and footnotes verbatim. " +
  "Output only the transcribed Markdown with no commentary or code fences.";

const PAGE_SPLIT_PATTERN = /\n\n(?=\[Page \d+\]\n)/;
const PAGE_HEADER_PATTERN = /^\[Page (\d+)\]\n([\s\S]*)$/;
const CODE_FENCE_WRAPPER_PATTERN = /^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeProvider(raw: string | undefined): OcrProviderPreset | undefined {
  const value = raw?.trim().toLowerCase();
  switch (value) {
    case "mistral":
    case "openai":
    case "openai-compatible":
    case "ollama":
    case "vllm":
    case "litellm":
    case "openrouter":
    case "azure":
    case "azure-foundry":
    case "custom":
      return value;
    default:
      return undefined;
  }
}

function normalizeProtocol(raw: string | undefined): OcrProtocol | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "mistral-ocr" || value === "mistral" || value === "ocr") {
    return "mistral-ocr";
  }
  if (
    value === "openai-chat" ||
    value === "openai" ||
    value === "openai-compatible" ||
    value === "chat-completions" ||
    value === "chat"
  ) {
    return "openai-chat";
  }
  return undefined;
}

function normalizeOpenAiPdfPart(raw: string | undefined): OcrOpenAiPdfPartMode {
  const value = raw?.trim().toLowerCase();
  if (value === "image_url" || value === "document_url" || value === "file") {
    return value;
  }
  return "file";
}

function isLoopbackHost(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

function isMistralHost(urlString: string): boolean {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    return host === "api.mistral.ai" || host.endsWith(".mistral.ai");
  } catch {
    return false;
  }
}

function hostOf(urlString: string): string {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Azure OpenAI, Azure AI Foundry and Azure AI model-inference endpoints. */
function isAzureHost(urlString: string): boolean {
  const host = hostOf(urlString);
  return [
    ".openai.azure.com",
    ".cognitiveservices.azure.com",
    ".services.ai.azure.com",
    ".models.ai.azure.com",
    ".inference.ai.azure.com",
  ].some((suffix) => host.endsWith(suffix));
}

function isOllamaHost(urlString: string, env: NodeJS.ProcessEnv): boolean {
  const host = hostOf(urlString);
  if (!host) return false;
  if (host === "ollama.com" || host.endsWith(".ollama.com")) return true;
  return host === hostOf(env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL);
}

function buildUrlFromBase(baseUrl: string, protocol: OcrProtocol): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (protocol === "openai-chat") {
    if (trimmed.endsWith("/chat/completions")) return trimmed;
    if (trimmed.endsWith("/v1") || trimmed.endsWith("/openai") || trimmed.endsWith("/models")) {
      return `${trimmed}/chat/completions`;
    }
    return `${trimmed}/v1/chat/completions`;
  }
  if (trimmed.endsWith("/ocr")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/ocr`;
  return `${trimmed}/v1/ocr`;
}

function parseExtraHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const cleanKey = key.trim();
      if (cleanKey && typeof value === "string") {
        out[cleanKey] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function resolveApiKey(
  env: NodeJS.ProcessEnv,
  provider: OcrProviderPreset,
  url: string,
  hasExplicitCustomEndpoint: boolean,
): string | undefined {
  const direct = env.OCR_API_KEY?.trim();
  if (direct) return direct;

  const fromNamedEnv = env.OCR_API_KEY_ENV?.trim();
  if (fromNamedEnv) {
    const namedValue = env[fromNamedEnv]?.trim();
    if (namedValue) return namedValue;
  }

  // A provider's own deployment key is only ever sent to that provider's
  // host; any other destination needs OCR_API_KEY or OCR_API_KEY_ENV.
  const host = hostOf(url);
  switch (provider) {
    case "ollama":
      return isOllamaHost(url, env) ? env.OLLAMA_API_KEY?.trim() || undefined : undefined;
    case "openai":
      return host === "api.openai.com" ? env.OPENAI_API_KEY?.trim() || undefined : undefined;
    case "openrouter":
      return host === "openrouter.ai" ? env.OPENROUTER_API_KEY?.trim() || undefined : undefined;
    case "azure":
      return isAzureHost(url)
        ? env.AZURE_API_KEY?.trim() || env.AZURE_FOUNDRY_API_KEY?.trim() || undefined
        : undefined;
    case "azure-foundry":
      return isAzureHost(url)
        ? env.AZURE_FOUNDRY_API_KEY?.trim() || env.AZURE_API_KEY?.trim() || undefined
        : undefined;
    case "mistral":
      return isMistralHost(url) ? env.MISTRAL_API_KEY?.trim() || undefined : undefined;
    default:
      return undefined;
  }
}

function defaultModelFor(provider: OcrProviderPreset, protocol: OcrProtocol, env: NodeJS.ProcessEnv): string {
  if (provider === "ollama") {
    return env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_OCR_MODEL;
  }
  if (provider === "openrouter") {
    return DEFAULT_OPENROUTER_OCR_MODEL;
  }
  if (protocol === "openai-chat") {
    return DEFAULT_OPENAI_OCR_MODEL;
  }
  return DEFAULT_MISTRAL_OCR_MODEL;
}

export function readOcrConfig(env: NodeJS.ProcessEnv = process.env): OcrConfig {
  const explicitUrl = env.OCR_API_URL?.trim() || env.MISTRAL_OCR_URL?.trim() || undefined;
  const explicitBaseUrl = env.OCR_BASE_URL?.trim() || undefined;
  const hasExplicitCustomEndpoint = Boolean(explicitUrl || explicitBaseUrl);

  const explicitProvider = normalizeProvider(env.OCR_PROVIDER);
  const explicitProtocol = normalizeProtocol(env.OCR_PROTOCOL) ?? normalizeProtocol(env.OCR_PROVIDER);

  let provider: OcrProviderPreset = explicitProvider ?? (hasExplicitCustomEndpoint ? "custom" : "mistral");
  if (!explicitProvider && explicitUrl && isMistralHost(explicitUrl)) {
    provider = "mistral";
  }

  let protocol: OcrProtocol =
    explicitProtocol ??
    (provider === "openai" ||
    provider === "openai-compatible" ||
    provider === "ollama" ||
    provider === "vllm" ||
    provider === "litellm" ||
    provider === "openrouter" ||
    provider === "azure"
      ? "openai-chat"
      : "mistral-ocr");

  if (!explicitProtocol && explicitUrl && /\/chat\/completions\/?$/i.test(explicitUrl)) {
    protocol = "openai-chat";
  }

  let url: string;
  if (explicitUrl) {
    url = explicitUrl;
  } else if (explicitBaseUrl) {
    url = buildUrlFromBase(explicitBaseUrl, protocol);
  } else if (provider === "ollama") {
    url = buildUrlFromBase(env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL, protocol);
  } else if (provider === "openrouter") {
    url = buildUrlFromBase(env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL, protocol);
  } else if (provider === "azure" || provider === "azure-foundry") {
    // Azure has no public default endpoint: never fall through to the OpenAI
    // or Mistral default with an Azure credential. OCR stays disabled.
    url = "";
  } else if (provider === "openai") {
    url = DEFAULT_OPENAI_CHAT_URL;
  } else if (protocol === "openai-chat") {
    url = DEFAULT_OPENAI_CHAT_URL;
  } else {
    url = DEFAULT_MISTRAL_OCR_URL;
  }

  const apiKey = url ? resolveApiKey(env, provider, url, hasExplicitCustomEndpoint) : undefined;
  const model =
    env.OCR_MODEL?.trim() ||
    env.MISTRAL_OCR_MODEL?.trim() ||
    defaultModelFor(provider, protocol, env);

  const authHeader = env.OCR_AUTH_HEADER?.trim() || "Authorization";
  const authScheme =
    env.OCR_AUTH_SCHEME !== undefined
      ? env.OCR_AUTH_SCHEME.trim()
      : authHeader.toLowerCase() === "authorization"
        ? "Bearer"
        : "";

  const allowUnauthenticatedEnv = env.OCR_ALLOW_UNAUTHENTICATED?.trim().toLowerCase();
  const hasExplicitEndpointOrProvider = Boolean(
    explicitUrl || explicitBaseUrl || explicitProvider || explicitProtocol,
  );
  const allowUnauthenticated =
    allowUnauthenticatedEnv === "true"
      ? true
      : allowUnauthenticatedEnv === "false"
        ? false
        : Boolean(url) && hasExplicitEndpointOrProvider && (provider === "ollama" || isLoopbackHost(url));

  return {
    provider,
    protocol,
    apiKey,
    url,
    model,
    authHeader,
    authScheme,
    extraHeaders: parseExtraHeaders(env.OCR_EXTRA_HEADERS_JSON),
    allowUnauthenticated,
    prompt: env.OCR_PROMPT?.trim() || DEFAULT_OCR_PROMPT,
    openAiPdfPart: normalizeOpenAiPdfPart(env.OCR_OPENAI_PDF_PART),
    minPageChars: positiveInt(env.OCR_MIN_PAGE_CHARS, DEFAULT_MIN_PAGE_CHARS),
    timeoutMs: positiveInt(env.OCR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxBytes: positiveInt(env.OCR_MAX_BYTES, DEFAULT_MAX_BYTES),
    disabled: env.OCR_DISABLED === "true",
  };
}

export function ocrEnabled(cfg: OcrConfig = readOcrConfig()): boolean {
  if (cfg.disabled || !cfg.url) return false;
  return Boolean(cfg.apiKey) || cfg.allowUnauthenticated;
}

export function buildOcrHeaders(cfg: OcrConfig): Record<string, string> {
  const headers: Record<string, string> = {
    ...cfg.extraHeaders,
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) {
    const value = cfg.authScheme ? `${cfg.authScheme} ${cfg.apiKey}` : cfg.apiKey;
    headers[cfg.authHeader] = value;
  }
  return headers;
}

/**
 * Character count of a page's body after removing `[Page N]` / `[Page N form fields]`
 * markers and whitespace, so marker-only pages are recognized as textless.
 */
export function meaningfulPageLength(pageSection: string): number {
  return pageSection
    .replace(/^\[Page \d+(?: form fields)?\]$/gm, "")
    .replace(/\s+/g, "").length;
}

/**
 * Split `extractPdfTextForIndex` output into per-page sections (`[Page N]\n...`).
 * When every page of an N-page PDF was empty, `extractPdfTextForIndex` returns
 * `{ text: "", textlessPageCount: N }`; reconstruct the N empty page sections so
 * OCR can populate them in place.
 */
export function splitIndexedPdfPages(extracted: ExtractedPdfIndexText): string[] {
  const textless = extracted.textlessPageCount ?? 0;
  if (!extracted.text) {
    return Array.from({ length: Math.max(0, textless) }, (_, i) => `[Page ${i + 1}]\n`);
  }
  return extracted.text.split(PAGE_SPLIT_PATTERN);
}

/** Zero-based page indices whose extracted text is below `minPageChars`. */
export function pagesNeedingOcr(
  pageSections: readonly string[],
  minPageChars = DEFAULT_MIN_PAGE_CHARS,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < pageSections.length; i++) {
    if (meaningfulPageLength(pageSections[i]!) < minPageChars) {
      indices.push(i);
    }
  }
  return indices;
}

type MistralOcrWireResponse = {
  pages?: Array<{
    index?: unknown;
    page?: unknown;
    page_number?: unknown;
    markdown?: unknown;
    text?: unknown;
    content?: unknown;
  }>;
};

type OpenAiChatWireResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: unknown;
    };
  }>;
};

async function postOcrJson<T>(
  payload: Record<string, unknown>,
  cfg: OcrConfig,
  fetchImpl: typeof fetch,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(cfg.url, {
        method: "POST",
        signal: controller.signal,
        headers: buildOcrHeaders(cfg),
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      throw new AppError(
        controller.signal.aborted ? "ocr.timeout" : "ocr.network_failed",
        controller.signal.aborted ? "OCR request timed out" : "OCR request failed",
        { cause },
      );
    }

    if (!response.ok) {
      const statusError = Object.assign(new Error("OCR HTTP failure"), {
        status: response.status,
      });
      throw new AppError("ocr.http_failed", "OCR endpoint returned an error status", {
        cause: statusError,
      });
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new AppError("ocr.invalid_response", "OCR endpoint returned non-JSON body", {
        cause,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function callMistralOcr(
  payload: Record<string, unknown>,
  cfg: OcrConfig,
  fetchImpl: typeof fetch,
): Promise<OcrPage[]> {
  const body = await postOcrJson<MistralOcrWireResponse>(payload, cfg, fetchImpl);
  if (!Array.isArray(body?.pages)) {
    throw new AppError("ocr.invalid_response", "OCR response missing pages");
  }

  const out: OcrPage[] = [];
  for (const page of body.pages) {
    const rawIndex =
      typeof page?.index === "number" && Number.isInteger(page.index)
        ? page.index
        : typeof page?.page_number === "number" && Number.isInteger(page.page_number)
          ? page.page_number - 1
          : typeof page?.page === "number" && Number.isInteger(page.page)
            ? page.page - 1
            : null;
    if (rawIndex === null) continue;
    const rawText =
      typeof page?.markdown === "string"
        ? page.markdown
        : typeof page?.text === "string"
          ? page.text
          : typeof page?.content === "string"
            ? page.content
            : "";
    out.push({
      index: rawIndex,
      text: rawText.trim(),
    });
  }
  return out;
}

function extractChatMessageText(body: OpenAiChatWireResponse): string {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  if (choice?.finish_reason === "length") {
    // Stopped at the token limit: a partial transcription must not be
    // published as complete coverage.
    throw new AppError("ocr.truncated", "OCR completion stopped at the token limit");
  }
  const content = choice?.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    throw new AppError("ocr.invalid_response", "OCR chat completion missing message content");
  }
  const trimmed = text.trim();
  const unwrapped = CODE_FENCE_WRAPPER_PATTERN.exec(trimmed);
  return (unwrapped ? unwrapped[1]! : trimmed).trim();
}

function parseOpenAiPdfPages(rawContent: string, requestedPages: readonly number[]): OcrPage[] {
  if (!rawContent) return [];

  // 1. Check if the model returned a JSON `{ "pages": [...] }` payload.
  if (rawContent.startsWith("{")) {
    try {
      const parsed = JSON.parse(rawContent) as MistralOcrWireResponse;
      if (Array.isArray(parsed?.pages)) {
        const out: OcrPage[] = [];
        for (const page of parsed.pages) {
          const idx =
            typeof page?.index === "number" && Number.isInteger(page.index)
              ? page.index
              : typeof page?.page_number === "number" && Number.isInteger(page.page_number)
                ? page.page_number - 1
                : null;
          const text =
            typeof page?.markdown === "string"
              ? page.markdown
              : typeof page?.text === "string"
                ? page.text
                : "";
          if (idx !== null) out.push({ index: idx, text: text.trim() });
        }
        if (out.length > 0) return out;
      }
    } catch {
      // Fall through to `[Page N]` marker parsing.
    }
  }

  // 2. Parse `[Page N]\n...` sections when present.
  const markerMatches = [...rawContent.matchAll(/(?:^|\n)\[Page (\d+)\]\s*\n([\s\S]*?)(?=(?:\n\[Page \d+\]\s*\n)|$)/g)];
  if (markerMatches.length > 0) {
    return markerMatches.map((m) => ({
      index: Number(m[1]) - 1,
      text: m[2]!.trim(),
    }));
  }

  // 3. Single requested page: map the entire Markdown response to that page index.
  if (requestedPages.length === 1) {
    return [{ index: requestedPages[0]!, text: rawContent }];
  }

  // 4. Multi-page request without page markers: page attribution is unknown.
  // Never attach the combined text to one page; reject so the caller keeps the
  // native extraction and reports the pages as not covered.
  throw new AppError(
    "ocr.invalid_response",
    "OCR response for multiple pages is not page-addressable",
  );
}

function buildOpenAiPdfContentPart(
  base64Pdf: string,
  mode: OcrOpenAiPdfPartMode,
): Record<string, unknown> {
  const dataUrl = `data:application/pdf;base64,${base64Pdf}`;
  if (mode === "image_url") {
    return { type: "image_url", image_url: { url: dataUrl } };
  }
  if (mode === "document_url") {
    return { type: "document_url", document_url: dataUrl };
  }
  return {
    type: "file",
    file: {
      filename: "document.pdf",
      file_data: dataUrl,
    },
  };
}

async function callOpenAiChatPdfOcr(
  base64Pdf: string,
  pages: readonly number[],
  cfg: OcrConfig,
  fetchImpl: typeof fetch,
): Promise<OcrPage[]> {
  const oneBased = pages.map((p) => p + 1).join(", ");
  const instruction =
    pages.length === 1
      ? `Transcribe only page ${pages[0]! + 1} of the attached PDF. Begin with "[Page ${pages[0]! + 1}]" on its own line.`
      : `Transcribe only pages ${oneBased} of the attached PDF. Prefix each page with "[Page N]" on its own line (1-based page number) separated by a blank line.`;

  const body = await postOcrJson<OpenAiChatWireResponse>(
    {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: "system", content: cfg.prompt },
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            buildOpenAiPdfContentPart(base64Pdf, cfg.openAiPdfPart),
          ],
        },
      ],
    },
    cfg,
    fetchImpl,
  );
  const text = extractChatMessageText(body);
  return parseOpenAiPdfPages(text, pages);
}

async function callOpenAiChatImageOcr(
  base64Image: string,
  mimeType: string,
  cfg: OcrConfig,
  fetchImpl: typeof fetch,
): Promise<OcrPage[]> {
  const body = await postOcrJson<OpenAiChatWireResponse>(
    {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: "system", content: cfg.prompt },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe all text on this document image." },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
    },
    cfg,
    fetchImpl,
  );
  const text = extractChatMessageText(body);
  return text ? [{ index: 0, text }] : [];
}

export async function ocrPdfPages(
  pdfBytes: ArrayBuffer | Uint8Array,
  pages: readonly number[],
  cfg: OcrConfig = readOcrConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<OcrPage[]> {
  if (!ocrEnabled(cfg) || pages.length === 0) return [];
  const view =
    pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  if (view.byteLength > cfg.maxBytes) {
    throw new AppError("ocr.file_too_large", "PDF exceeds OCR size limit");
  }
  const base64 = Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString(
    "base64",
  );
  if (cfg.protocol === "openai-chat") {
    return callOpenAiChatPdfOcr(base64, pages, cfg, fetchImpl);
  }
  return callMistralOcr(
    {
      model: cfg.model,
      document: {
        type: "document_url",
        document_url: `data:application/pdf;base64,${base64}`,
      },
      pages: [...pages],
      table_format: "markdown",
    },
    cfg,
    fetchImpl,
  );
}

/**
 * Run OCR on a single raster image (`image/png`, `image/jpeg`, `image/webp`)
 * using the configured OCR endpoint (`mistral-ocr` or `openai-chat`) and format
 * the output as `[Page 1]\n<markdown>` to match PDF page conventions.
 */
export async function extractImageOcrText(
  imageBytes: ArrayBuffer | Uint8Array,
  mimeType: "image/png" | "image/jpeg" | "image/webp",
  cfg: OcrConfig = readOcrConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<EnrichedPdfIndexText> {
  if (!ocrEnabled(cfg)) {
    return { text: "", textlessPageCount: 1, ocrPageCount: 0 };
  }
  const view =
    imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes);
  if (view.byteLength > cfg.maxBytes) {
    return {
      text: "",
      textlessPageCount: 1,
      ocrPageCount: 0,
      error: new AppError("ocr.file_too_large", "Image exceeds OCR size limit"),
    };
  }
  try {
    const base64 = Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString(
      "base64",
    );
    const pages =
      cfg.protocol === "openai-chat"
        ? await callOpenAiChatImageOcr(base64, mimeType, cfg, fetchImpl)
        : await callMistralOcr(
            {
              model: cfg.model,
              document: {
                type: "image_url",
                image_url: `data:${mimeType};base64,${base64}`,
              },
              table_format: "markdown",
            },
            cfg,
            fetchImpl,
          );
    const body = pages
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!body) {
      return { text: "", textlessPageCount: 1, ocrPageCount: 0 };
    }
    return {
      text: `[Page 1]\n${body}`,
      textlessPageCount: 0,
      ocrPageCount: 1,
    };
  } catch (cause) {
    const error =
      cause instanceof AppError
        ? cause
        : new AppError("ocr.failed", "Image OCR failed", { cause });
    return { text: "", textlessPageCount: 1, ocrPageCount: 0, error };
  }
}

/**
 * Fill page sections that have no body text with OCR text, preserving `[Page N]`
 * markers. Sections that already contain native text are never replaced.
 */
export function mergeOcrIntoPdfPages(
  pageSections: readonly string[],
  ocrPages: readonly OcrPage[],
  minPageChars = DEFAULT_MIN_PAGE_CHARS,
  requestedPages?: readonly number[],
): { text: string; textlessPageCount: number; ocrPageCount: number } {
  const merged = [...pageSections];
  const populatedByOcr = new Set<number>();
  // Only pages selected for OCR may be replaced; an endpoint that also
  // returns a native page must not overwrite its text.
  const allowed = requestedPages ? new Set(requestedPages) : undefined;

  for (const ocr of ocrPages) {
    if (ocr.index < 0 || ocr.index >= merged.length) continue;
    if (allowed && !allowed.has(ocr.index)) continue;
    const cleaned = ocr.text.trim();
    if (!cleaned) continue;
    // Native text always wins: a short native page can be selected for OCR,
    // but its existing body text is never replaced.
    if (meaningfulPageLength(merged[ocr.index]!) > 0) continue;
    const match = PAGE_HEADER_PATTERN.exec(merged[ocr.index]!);
    const pageNumber = match ? Number(match[1]) : ocr.index + 1;
    merged[ocr.index] = `[Page ${pageNumber}]\n${cleaned}`;
    populatedByOcr.add(ocr.index);
  }

  let textlessPageCount = 0;
  for (let i = 0; i < merged.length; i++) {
    if (!populatedByOcr.has(i) && meaningfulPageLength(merged[i]!) < minPageChars) {
      textlessPageCount++;
    }
  }

  const ocrPageCount = populatedByOcr.size;
  // The OCR threshold selects candidates; it never decides that existing
  // text may be discarded. Empty only when no page has any body at all.
  const hasAnyText = merged.some((section) => meaningfulPageLength(section) > 0);
  return {
    text: hasAnyText ? merged.join("\n\n") : "",
    textlessPageCount,
    ocrPageCount,
  };
}

/**
 * Enrich `extractPdfTextForIndex` output with OCR for any textless pages.
 * Never throws: on OCR failure, returns the original `pdf.js` extraction and
 * surfaces the typed `AppError` on `error` so the caller can log a non-fatal warning.
 */
export async function enrichExtractedPdfText(
  pdfBytes: ArrayBuffer | Uint8Array,
  extracted: ExtractedPdfIndexText,
  cfg: OcrConfig = readOcrConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<EnrichedPdfIndexText> {
  if (!ocrEnabled(cfg) || !extracted.textlessPageCount || extracted.textlessPageCount <= 0) {
    return { ...extracted, ocrPageCount: 0 };
  }

  const pageSections = splitIndexedPdfPages(extracted);
  const missing = pagesNeedingOcr(pageSections, cfg.minPageChars);
  if (missing.length === 0) {
    return { ...extracted, ocrPageCount: 0 };
  }

  try {
    const ocrPages = await ocrPdfPages(pdfBytes, missing, cfg, fetchImpl);
    const merged = mergeOcrIntoPdfPages(pageSections, ocrPages, cfg.minPageChars, missing);
    if (merged.ocrPageCount === 0) {
      // OCR added nothing usable: keep the original extraction unchanged.
      return { ...extracted, ocrPageCount: 0 };
    }
    return {
      text: merged.text,
      textlessPageCount: merged.textlessPageCount,
      ocrPageCount: merged.ocrPageCount,
    };
  } catch (cause) {
    const error =
      cause instanceof AppError
        ? cause
        : new AppError("ocr.failed", "OCR enrichment failed", { cause });
    return {
      ...extracted,
      ocrPageCount: 0,
      error,
    };
  }
}

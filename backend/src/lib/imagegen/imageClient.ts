/**
 * Provider-agnostic image generation for the assistant's `generate_image`
 * tool. Opt-in: nothing is sent anywhere until IMAGE_GEN_PROVIDER (or an
 * explicit IMAGE_GEN_API_URL / IMAGE_GEN_BASE_URL) is configured.
 *
 * Two wire protocols cover the common engines:
 *
 *   openai-images  POST {base}/v1/images/generations
 *                  OpenAI (gpt-image-1, dall-e-3), Azure OpenAI, LiteLLM,
 *                  LocalAI, vLLM-omni and other OpenAI-compatible servers.
 *   automatic1111  POST {base}/sdapi/v1/txt2img
 *                  Stable Diffusion WebUI / Forge / SD.Next running locally.
 *
 * Key isolation mirrors lib/ocr/ocrClient.ts: a provider's deployment key is
 * only ever sent to that provider's own host; an explicit custom endpoint
 * receives only IMAGE_GEN_API_KEY (or the variable IMAGE_GEN_API_KEY_ENV
 * names). Loopback endpoints may run keyless.
 *
 * This file is infrastructure: it must not import from modules/.
 */
import { AppError } from "../appError";

export type ImageGenProtocol = "openai-images" | "automatic1111";

export type ImageGenProviderPreset =
  | "openai"
  | "openai-compatible"
  | "azure"
  | "litellm"
  | "localai"
  | "automatic1111"
  | "custom";

export type ImageGenConfig = {
  enabled: boolean;
  provider: ImageGenProviderPreset;
  protocol: ImageGenProtocol;
  url: string;
  apiKey?: string;
  model: string;
  authHeader: string;
  authScheme: string;
  extraHeaders: Record<string, string>;
  allowUnauthenticated: boolean;
  defaultSize: string;
  allowedSizes: string[];
  quality?: string;
  sendResponseFormat: boolean;
  steps: number;
  timeoutMs: number;
  maxBytes: number;
};

export type GeneratedImage = {
  bytes: Buffer;
  extension: "png" | "jpg";
  mimeType: "image/png" | "image/jpeg";
  revisedPrompt?: string;
};

export const MAX_IMAGE_PROMPT_CHARS = 4_000;

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_AUTOMATIC1111_BASE_URL = "http://127.0.0.1:7860";
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_ALLOWED_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_STEPS = 30;
const SIZE_PATTERN = /^(\d{2,4})x(\d{2,4})$/;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function normalizeProvider(raw: string | undefined): ImageGenProviderPreset | undefined {
  const value = raw?.trim().toLowerCase();
  switch (value) {
    case "openai":
    case "openai-compatible":
    case "azure":
    case "litellm":
    case "localai":
    case "automatic1111":
    case "custom":
      return value;
    case "a1111":
    case "forge":
    case "sdwebui":
      return "automatic1111";
    default:
      return undefined;
  }
}

function normalizeProtocol(raw: string | undefined): ImageGenProtocol | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "openai-images" || value === "openai" || value === "images") {
    return "openai-images";
  }
  if (value === "automatic1111" || value === "a1111" || value === "sdapi") {
    return "automatic1111";
  }
  return undefined;
}

function isLoopbackHost(urlString: string): boolean {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function isOpenAiHost(urlString: string): boolean {
  try {
    return new URL(urlString).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function isAzureHost(urlString: string): boolean {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    return [".openai.azure.com", ".cognitiveservices.azure.com", ".services.ai.azure.com"].some((suffix) =>
      host.endsWith(suffix),
    );
  } catch {
    return false;
  }
}

export function buildImageGenUrl(baseUrl: string, protocol: ImageGenProtocol): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (protocol === "automatic1111") {
    if (trimmed.endsWith("/sdapi/v1/txt2img")) return trimmed;
    return `${trimmed}/sdapi/v1/txt2img`;
  }
  if (trimmed.endsWith("/images/generations")) return trimmed;
  if (trimmed.endsWith("/v1") || trimmed.endsWith("/openai")) {
    return `${trimmed}/images/generations`;
  }
  return `${trimmed}/v1/images/generations`;
}

function parseExtraHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.trim() && typeof value === "string") out[key.trim()] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function parseSizes(raw: string | undefined): string[] {
  const sizes = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SIZE_PATTERN.test(s));
  return sizes.length ? sizes : DEFAULT_ALLOWED_SIZES;
}

function resolveApiKey(
  env: NodeJS.ProcessEnv,
  provider: ImageGenProviderPreset,
  url: string,
  explicitEndpoint: boolean,
): string | undefined {
  const direct = env.IMAGE_GEN_API_KEY?.trim();
  if (direct) return direct;
  const named = env.IMAGE_GEN_API_KEY_ENV?.trim();
  if (named) {
    const value = env[named]?.trim();
    if (value) return value;
  }
  switch (provider) {
    case "openai":
      // The deployment's OpenAI key goes to api.openai.com and nowhere else.
      return isOpenAiHost(url) ? env.OPENAI_API_KEY?.trim() || undefined : undefined;
    case "azure":
      // Only to an explicitly configured Azure endpoint, never to the OpenAI
      // default or an unrelated host.
      return explicitEndpoint && isAzureHost(url) ? env.AZURE_API_KEY?.trim() || undefined : undefined;
    default:
      return undefined;
  }
}

export function readImageGenConfig(env: NodeJS.ProcessEnv = process.env): ImageGenConfig {
  const explicitUrl = env.IMAGE_GEN_API_URL?.trim();
  const explicitBase = env.IMAGE_GEN_BASE_URL?.trim();
  const explicitEndpoint = !!(explicitUrl || explicitBase);
  const configuredProvider = normalizeProvider(env.IMAGE_GEN_PROVIDER);
  const provider: ImageGenProviderPreset =
    configuredProvider ?? (explicitEndpoint ? "custom" : "openai");
  const protocol: ImageGenProtocol =
    normalizeProtocol(env.IMAGE_GEN_PROTOCOL) ??
    (provider === "automatic1111" ? "automatic1111" : "openai-images");

  const url = explicitUrl
    ? explicitUrl
    : buildImageGenUrl(
        explicitBase ||
          (protocol === "automatic1111" ? DEFAULT_AUTOMATIC1111_BASE_URL : DEFAULT_OPENAI_BASE_URL),
        protocol,
      );

  const apiKey = resolveApiKey(env, provider, url, explicitEndpoint);
  const allowUnauthenticated =
    truthy(env.IMAGE_GEN_ALLOW_UNAUTHENTICATED) ||
    isLoopbackHost(url) ||
    protocol === "automatic1111";

  const model =
    env.IMAGE_GEN_MODEL?.trim() ||
    (protocol === "openai-images" ? DEFAULT_OPENAI_IMAGE_MODEL : "");

  const allowedSizes = parseSizes(env.IMAGE_GEN_ALLOWED_SIZES);
  const requestedDefault = env.IMAGE_GEN_DEFAULT_SIZE?.trim().toLowerCase();
  const defaultSize =
    requestedDefault && allowedSizes.includes(requestedDefault)
      ? requestedDefault
      : allowedSizes.includes(DEFAULT_SIZE)
        ? DEFAULT_SIZE
        : allowedSizes[0]!;

  // gpt-image-* always answers with b64_json and rejects the parameter;
  // dall-e and most compatible servers need it to avoid a hosted URL.
  const responseFormatOverride = env.IMAGE_GEN_SEND_RESPONSE_FORMAT?.trim();
  const sendResponseFormat = responseFormatOverride
    ? truthy(responseFormatOverride)
    : !/^gpt-image/i.test(model);

  const optedIn = !!configuredProvider || explicitEndpoint;
  const enabled =
    optedIn &&
    !truthy(env.IMAGE_GEN_DISABLED) &&
    (!!apiKey || allowUnauthenticated);

  return {
    enabled,
    provider,
    protocol,
    url,
    apiKey,
    model,
    authHeader: env.IMAGE_GEN_AUTH_HEADER?.trim() || (provider === "azure" ? "api-key" : "Authorization"),
    authScheme:
      env.IMAGE_GEN_AUTH_SCHEME !== undefined
        ? env.IMAGE_GEN_AUTH_SCHEME.trim()
        : provider === "azure"
          ? ""
          : "Bearer",
    extraHeaders: parseExtraHeaders(env.IMAGE_GEN_EXTRA_HEADERS_JSON),
    allowUnauthenticated,
    defaultSize,
    allowedSizes,
    quality: env.IMAGE_GEN_QUALITY?.trim() || undefined,
    sendResponseFormat,
    steps: positiveInt(env.IMAGE_GEN_STEPS, DEFAULT_STEPS),
    timeoutMs: positiveInt(env.IMAGE_GEN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxBytes: positiveInt(env.IMAGE_GEN_MAX_BYTES, DEFAULT_MAX_BYTES),
  };
}

export function imageGenerationEnabled(cfg: ImageGenConfig = readImageGenConfig()): boolean {
  return cfg.enabled;
}

export function buildImageGenHeaders(cfg: ImageGenConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...cfg.extraHeaders,
  };
  if (cfg.apiKey) {
    headers[cfg.authHeader] = cfg.authScheme ? `${cfg.authScheme} ${cfg.apiKey}` : cfg.apiKey;
  }
  return headers;
}

/** The image type the bytes actually are, from their magic number. */
export function sniffImageType(bytes: Uint8Array): GeneratedImage["extension"] | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  return null;
}

export function normalizeImageSize(requested: unknown, cfg: ImageGenConfig): string {
  if (typeof requested !== "string") return cfg.defaultSize;
  const value = requested.trim().toLowerCase();
  if (value === "square") return cfg.allowedSizes.find((s) => isSquare(s)) ?? cfg.defaultSize;
  if (value === "landscape") return cfg.allowedSizes.find((s) => ratio(s) > 1) ?? cfg.defaultSize;
  if (value === "portrait") return cfg.allowedSizes.find((s) => ratio(s) < 1) ?? cfg.defaultSize;
  return cfg.allowedSizes.includes(value) ? value : cfg.defaultSize;
}

function dims(size: string): [number, number] {
  const m = SIZE_PATTERN.exec(size);
  return m ? [Number(m[1]), Number(m[2])] : [1024, 1024];
}
function ratio(size: string): number {
  const [w, h] = dims(size);
  return w / h;
}
function isSquare(size: string): boolean {
  return ratio(size) === 1;
}

function decodeBase64Image(b64: string, cfg: ImageGenConfig): GeneratedImage {
  const clean = b64.replace(/^data:image\/[a-z]+;base64,/i, "");
  // Base64 inflates by 4/3: refuse before allocating an oversized buffer.
  if (clean.length * 0.75 > cfg.maxBytes) {
    throw new AppError("image_generation.too_large", "Generated image exceeds size limit");
  }
  const bytes = Buffer.from(clean, "base64");
  const extension = sniffImageType(bytes);
  if (!extension) {
    throw new AppError("image_generation.invalid_response", "Generated image is not PNG or JPEG");
  }
  return { bytes, extension, mimeType: extension === "png" ? "image/png" : "image/jpeg" };
}

async function postJson(
  cfg: ImageGenConfig,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, cfg.timeoutMs);
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  // The deadline and caller cancellation stay armed until the body is read:
  // fetch() resolves on headers, and a slow body must not outlive either.
  try {
    let response: Response;
    try {
      response = await fetchImpl(cfg.url, {
        method: "POST",
        headers: buildImageGenHeaders(cfg),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new AppError(
        controller.signal.aborted ? "image_generation.timeout" : "image_generation.network_failed",
        "Image generation request failed",
        { cause },
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("image_generation.http_failed", "Image endpoint returned an error status", {
        cause: { status: response.status },
      });
    }
    let raw: string;
    try {
      raw = await readBoundedText(response, maxResponseBytes(cfg));
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError(
        timedOut || controller.signal.aborted ? "image_generation.timeout" : "image_generation.network_failed",
        "Image generation response could not be read",
        { cause },
      );
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (cause) {
      throw new AppError("image_generation.invalid_response", "Image endpoint returned non-JSON body", {
        cause,
      });
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

/** Base64 overhead (4/3) plus room for bounded JSON metadata. */
function maxResponseBytes(cfg: ImageGenConfig): number {
  return Math.ceil((cfg.maxBytes * 4) / 3) + 64 * 1024;
}

/** Read a response body as text, cancelling it once it exceeds `limit` bytes. */
async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError("image_generation.too_large", "Image response exceeds the size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("image_generation.too_large", "Image response exceeds the size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
}

/**
 * Generate one image. Throws AppError with a static `image_generation.*` kind
 * on every failure, so callers can report without leaking the prompt.
 */
export async function generateImageBytes(
  params: { prompt: string; size?: unknown; negativePrompt?: string; signal?: AbortSignal },
  cfg: ImageGenConfig = readImageGenConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<GeneratedImage> {
  if (!cfg.enabled) {
    throw new AppError("image_generation.disabled", "Image generation is not configured");
  }
  const prompt = params.prompt.trim().slice(0, MAX_IMAGE_PROMPT_CHARS);
  if (!prompt) {
    throw new AppError("image_generation.invalid_request", "Image prompt is empty");
  }
  const size = normalizeImageSize(params.size, cfg);

  if (cfg.protocol === "automatic1111") {
    const [width, height] = dims(size);
    const json = (await postJson(
      cfg,
      {
        prompt,
        negative_prompt: params.negativePrompt?.slice(0, MAX_IMAGE_PROMPT_CHARS) ?? "",
        width,
        height,
        steps: cfg.steps,
        batch_size: 1,
        n_iter: 1,
        ...(cfg.model ? { override_settings: { sd_model_checkpoint: cfg.model } } : {}),
      },
      fetchImpl,
      params.signal,
    )) as { images?: unknown };
    const first = Array.isArray(json?.images) ? json.images[0] : undefined;
    if (typeof first !== "string") {
      throw new AppError("image_generation.invalid_response", "Image response missing images");
    }
    return decodeBase64Image(first, cfg);
  }

  const json = (await postJson(
    cfg,
    {
      ...(cfg.model ? { model: cfg.model } : {}),
      prompt,
      n: 1,
      size,
      ...(cfg.quality ? { quality: cfg.quality } : {}),
      ...(cfg.sendResponseFormat ? { response_format: "b64_json" } : {}),
    },
    fetchImpl,
    params.signal,
  )) as { data?: Array<{ b64_json?: unknown; revised_prompt?: unknown }> };
  const first = Array.isArray(json?.data) ? json.data[0] : undefined;
  if (typeof first?.b64_json !== "string") {
    // A hosted URL is deliberately not followed: fetching an arbitrary
    // provider-supplied URL from the backend is an SSRF surface.
    throw new AppError("image_generation.invalid_response", "Image response missing b64_json");
  }
  const image = decodeBase64Image(first.b64_json, cfg);
  if (typeof first.revised_prompt === "string") {
    image.revisedPrompt = first.revised_prompt.slice(0, MAX_IMAGE_PROMPT_CHARS);
  }
  return image;
}

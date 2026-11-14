import { describe, expect, it, vi } from "vitest";
import {
  buildImageGenHeaders,
  buildImageGenUrl,
  generateImageBytes,
  normalizeImageSize,
  readImageGenConfig,
  sniffImageType,
} from "../imageClient";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readImageGenConfig", () => {
  it("is off until a provider or endpoint is configured", () => {
    expect(readImageGenConfig({ OPENAI_API_KEY: "sk-x" } as never).enabled).toBe(false);
  });

  it("uses the OpenAI key only for api.openai.com", () => {
    const official = readImageGenConfig({ IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as never);
    expect(official.enabled).toBe(true);
    expect(official.apiKey).toBe("sk-x");
    expect(official.url).toBe("https://api.openai.com/v1/images/generations");

    const custom = readImageGenConfig({
      IMAGE_GEN_PROVIDER: "openai",
      IMAGE_GEN_BASE_URL: "https://images.example.test/v1",
      OPENAI_API_KEY: "sk-x",
    } as never);
    expect(custom.apiKey).toBeUndefined();
    expect(custom.enabled).toBe(false);
  });

  it("runs keyless against a local Stable Diffusion WebUI", () => {
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "automatic1111" } as never);
    expect(cfg.enabled).toBe(true);
    expect(cfg.protocol).toBe("automatic1111");
    expect(cfg.url).toBe("http://127.0.0.1:7860/sdapi/v1/txt2img");
  });

  it("does not send response_format to gpt-image models", () => {
    expect(readImageGenConfig({ IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "k" } as never).sendResponseFormat).toBe(false);
    expect(
      readImageGenConfig({ IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "k", IMAGE_GEN_MODEL: "dall-e-3" } as never)
        .sendResponseFormat,
    ).toBe(true);
  });

  it("honours IMAGE_GEN_DISABLED", () => {
    expect(
      readImageGenConfig({ IMAGE_GEN_PROVIDER: "automatic1111", IMAGE_GEN_DISABLED: "true" } as never).enabled,
    ).toBe(false);
  });

  it("uses the api-key header for Azure", () => {
    const cfg = readImageGenConfig({
      IMAGE_GEN_PROVIDER: "azure",
      IMAGE_GEN_API_URL: "https://r.openai.azure.com/openai/deployments/img/images/generations?api-version=2025-04-01-preview",
      AZURE_API_KEY: "az",
    } as never);
    expect(buildImageGenHeaders(cfg)["api-key"]).toBe("az");
  });
});

describe("helpers", () => {
  it("builds endpoint URLs", () => {
    expect(buildImageGenUrl("http://localhost:4000", "openai-images")).toBe("http://localhost:4000/v1/images/generations");
    expect(buildImageGenUrl("http://localhost:4000/v1/", "openai-images")).toBe("http://localhost:4000/v1/images/generations");
    expect(buildImageGenUrl("http://h:7860", "automatic1111")).toBe("http://h:7860/sdapi/v1/txt2img");
  });

  it("sniffs PNG and JPEG only", () => {
    expect(sniffImageType(PNG)).toBe("png");
    expect(sniffImageType(JPG)).toBe("jpg");
    expect(sniffImageType(Buffer.from("%PDF-1.7"))).toBeNull();
  });

  it("maps orientation words and rejects unknown sizes", () => {
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "automatic1111" } as never);
    expect(normalizeImageSize("landscape", cfg)).toBe("1536x1024");
    expect(normalizeImageSize("portrait", cfg)).toBe("1024x1536");
    expect(normalizeImageSize("9999x9999", cfg)).toBe("1024x1024");
  });
});

describe("generateImageBytes", () => {
  it("decodes an OpenAI-compatible b64_json response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ b64_json: PNG.toString("base64"), revised_prompt: "r" }] }),
    );
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "k" } as never);
    const image = await generateImageBytes({ prompt: "timeline", size: "square" }, cfg, fetchMock);
    expect(image.extension).toBe("png");
    expect(image.revisedPrompt).toBe("r");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).toMatchObject({ model: "gpt-image-1", n: 1, size: "1024x1024" });
    expect(body).not.toHaveProperty("response_format");
  });

  it("decodes an automatic1111 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ images: [JPG.toString("base64")] }));
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "automatic1111" } as never);
    const image = await generateImageBytes({ prompt: "diagram" }, cfg, fetchMock);
    expect(image.mimeType).toBe("image/jpeg");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toMatchObject({ width: 1024, height: 1024 });
  });

  it("refuses a hosted URL instead of fetching it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ url: "http://169.254.169.254/x" }] }));
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "k" } as never);
    await expect(generateImageBytes({ prompt: "x" }, cfg, fetchMock)).rejects.toMatchObject({
      kind: "image_generation.invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects bytes that are not an image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ b64_json: Buffer.from("<html>").toString("base64") }] }),
    );
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "k" } as never);
    await expect(generateImageBytes({ prompt: "x" }, cfg, fetchMock)).rejects.toBeTruthy();
  });

  it("reports HTTP failures with a static kind", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "secret prompt echoed" }, 400));
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "k" } as never);
    await expect(generateImageBytes({ prompt: "x" }, cfg, fetchMock)).rejects.toMatchObject({
      kind: "image_generation.http_failed",
    });
  });
});

describe("image generation review hardening", () => {
  it("never sends AZURE_API_KEY without an explicit Azure endpoint", () => {
    expect(readImageGenConfig({ IMAGE_GEN_PROVIDER: "azure", AZURE_API_KEY: "a" } as never).apiKey).toBeUndefined();
    expect(readImageGenConfig({
      IMAGE_GEN_PROVIDER: "azure", IMAGE_GEN_API_URL: "https://images.example.test/v1/images/generations", AZURE_API_KEY: "a",
    } as never).apiKey).toBeUndefined();
  });

  it("keeps the deadline armed while the body is still streaming", async () => {
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "automatic1111", IMAGE_GEN_TIMEOUT_MS: "50" } as never);
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"images":['));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(generateImageBytes({ prompt: "x" }, cfg, fetchImpl)).rejects.toMatchObject({ kind: "image_generation.timeout" });
  });

  it("rejects a response body larger than the image limit allows", async () => {
    const cfg = readImageGenConfig({ IMAGE_GEN_PROVIDER: "automatic1111", IMAGE_GEN_MAX_BYTES: "1000" } as never);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ images: ["A".repeat(200_000)] }), { status: 200 })) as unknown as typeof fetch;
    await expect(generateImageBytes({ prompt: "x" }, cfg, fetchImpl)).rejects.toMatchObject({ kind: "image_generation.too_large" });
  });
});

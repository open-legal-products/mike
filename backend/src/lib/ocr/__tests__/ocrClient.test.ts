import { describe, expect, it, vi } from "vitest";
import {
  buildOcrHeaders,
  enrichExtractedPdfText,
  extractImageOcrText,
  meaningfulPageLength,
  mergeOcrIntoPdfPages,
  ocrEnabled,
  ocrPdfPages,
  pagesNeedingOcr,
  readOcrConfig,
  splitIndexedPdfPages,
} from "../ocrClient";

const mistralCfg = readOcrConfig({
  MISTRAL_API_KEY: "test-mistral-key",
  OCR_MIN_PAGE_CHARS: "10",
});
const samplePdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const samplePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mistralJsonResponse(pages: Array<{ index: number; markdown: string }>, status = 200) {
  return new Response(JSON.stringify({ pages }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openAiChatResponse(content: unknown, status = 200) {
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content } }],
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("OCR page detection, configuration, and multi-provider execution", () => {
  it("ignores page markers and whitespace when measuring page text", () => {
    expect(meaningfulPageLength("[Page 1]\n   \n[Page 1 form fields]\n")).toBe(0);
    expect(meaningfulPageLength("[Page 2]\nClausola compromissoria")).toBe(22);
  });

  it("reconstructs empty page sections for a fully scanned PDF", () => {
    const sections = splitIndexedPdfPages({ text: "", textlessPageCount: 3 });
    expect(sections).toEqual(["[Page 1]\n", "[Page 2]\n", "[Page 3]\n"]);
    expect(pagesNeedingOcr(sections, 10)).toEqual([0, 1, 2]);
  });

  it("selects only textless pages in a mixed native + scanned PDF", () => {
    const sections = splitIndexedPdfPages({
      text: "[Page 1]\nTesto nativo digitale sufficiente\n\n[Page 2]\n\n\n[Page 3]\nAltro testo nativo",
      textlessPageCount: 1,
    });
    expect(pagesNeedingOcr(sections, 10)).toEqual([1]);
  });

  it("is disabled by default without credentials and respects OCR_DISABLED=true", () => {
    expect(ocrEnabled(readOcrConfig({}))).toBe(false);
    expect(ocrEnabled(readOcrConfig({ MISTRAL_API_KEY: "   " }))).toBe(false);
    expect(
      ocrEnabled(readOcrConfig({ MISTRAL_API_KEY: "k", OCR_DISABLED: "true" })),
    ).toBe(false);
    expect(ocrEnabled(mistralCfg)).toBe(true);
  });

  it("supports custom OCR_API_URL, OCR_BASE_URL, OCR_API_KEY, OCR_API_KEY_ENV, and custom auth headers", () => {
    const custom = readOcrConfig({
      OCR_BASE_URL: "https://ocr-gateway.internal/v1/",
      OCR_PROTOCOL: "openai-chat",
      OCR_API_KEY: "direct-ocr-secret",
      OCR_MODEL: "Qwen/Qwen2.5-VL-72B-Instruct",
      OCR_AUTH_HEADER: "api-key",
      OCR_EXTRA_HEADERS_JSON: JSON.stringify({ "X-Tenant": "litigation" }),
    });
    expect(custom.url).toBe("https://ocr-gateway.internal/v1/chat/completions");
    expect(custom.protocol).toBe("openai-chat");
    expect(custom.apiKey).toBe("direct-ocr-secret");
    expect(custom.model).toBe("Qwen/Qwen2.5-VL-72B-Instruct");
    expect(buildOcrHeaders(custom)).toEqual({
      "Content-Type": "application/json",
      "X-Tenant": "litigation",
      "api-key": "direct-ocr-secret",
    });

    const viaEnvRef = readOcrConfig({
      OCR_API_URL: "https://my-foundry.services.ai.azure.com/models/ocr",
      OCR_API_KEY_ENV: "AZURE_FOUNDRY_API_KEY",
      AZURE_FOUNDRY_API_KEY: "foundry-secret",
    });
    expect(viaEnvRef.protocol).toBe("mistral-ocr");
    expect(viaEnvRef.apiKey).toBe("foundry-secret");
  });

  it("does not leak MISTRAL_API_KEY to an unrelated custom endpoint unless explicitly configured", () => {
    const customWithoutKey = readOcrConfig({
      OCR_API_URL: "https://third-party-ocr.example.com/v1/ocr",
      MISTRAL_API_KEY: "mistral-secret-do-not-leak",
    });
    expect(customWithoutKey.apiKey).toBeUndefined();
    expect(ocrEnabled(customWithoutKey)).toBe(false);
  });

  it("enables keyless local OCR for Ollama or loopback endpoints", () => {
    const ollamaCfg = readOcrConfig({
      OCR_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
      OCR_MODEL: "qwen2.5vl:7b",
    });
    expect(ollamaCfg.protocol).toBe("openai-chat");
    expect(ollamaCfg.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(ollamaCfg.apiKey).toBeUndefined();
    expect(ollamaCfg.allowUnauthenticated).toBe(true);
    expect(ocrEnabled(ollamaCfg)).toBe(true);
    expect(buildOcrHeaders(ollamaCfg)).toEqual({
      "Content-Type": "application/json",
    });
  });

  it("sends Base64 PDF to /v1/ocr with only the missing page indices in mistral-ocr mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mistralJsonResponse([{ index: 1, markdown: "Allegato scansionato" }]));
    const pages = await ocrPdfPages(
      samplePdf,
      [1],
      mistralCfg,
      fetchMock as unknown as typeof fetch,
    );
    expect(pages).toEqual([{ index: 1, text: "Allegato scansionato" }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.mistral.ai/v1/ocr");
    const parsed = JSON.parse(init.body as string);
    expect(parsed.model).toBe("mistral-ocr-latest");
    expect(parsed.pages).toEqual([1]);
    expect(parsed.document.document_url).toMatch(/^data:application\/pdf;base64,/);
  });

  it("enriches scanned PDF pages via an OpenAI-compatible /v1/chat/completions endpoint", async () => {
    const openAiCfg = readOcrConfig({
      OCR_BASE_URL: "http://localhost:8000/v1",
      OCR_PROTOCOL: "openai-chat",
      OCR_MODEL: "allenai/olmOCR-7B",
      OCR_MIN_PAGE_CHARS: "10",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      openAiChatResponse(
        "```markdown\n[Page 2]\nVerbale di udienza scansionato\n```",
      ),
    );
    const enriched = await enrichExtractedPdfText(
      samplePdf,
      {
        text: "[Page 1]\nAtto nativo digitale completo\n\n[Page 2]\n",
        textlessPageCount: 1,
      },
      openAiCfg,
      fetchMock as unknown as typeof fetch,
    );
    expect(enriched).toEqual({
      text: "[Page 1]\nAtto nativo digitale completo\n\n[Page 2]\nVerbale di udienza scansionato",
      textlessPageCount: 0,
      ocrPageCount: 1,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:8000/v1/chat/completions");
    const parsed = JSON.parse(init.body as string);
    expect(parsed.model).toBe("allenai/olmOCR-7B");
    expect(parsed.messages[1].content[1].type).toBe("file");
    expect(parsed.messages[1].content[1].file.file_data).toMatch(/^data:application\/pdf;base64,/);
  });

  it("extracts image text via OpenAI-compatible Vision chat completions", async () => {
    const openAiCfg = readOcrConfig({
      OCR_PROVIDER: "openai",
      OCR_API_KEY: "sk-test-openai",
      OCR_MODEL: "gpt-4.1-mini",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      openAiChatResponse("Repubblica Italiana — Sentenza n. 1234/2026"),
    );
    const result = await extractImageOcrText(
      samplePng,
      "image/png",
      openAiCfg,
      fetchMock as unknown as typeof fetch,
    );
    expect(result).toEqual({
      text: "[Page 1]\nRepubblica Italiana — Sentenza n. 1234/2026",
      textlessPageCount: 0,
      ocrPageCount: 1,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test-openai");
    const parsed = JSON.parse(init.body as string);
    expect(parsed.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });
  });

  it("enriches a fully scanned PDF and clears textlessPageCount", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mistralJsonResponse([
        { index: 0, markdown: "Atto di citazione" },
        { index: 1, markdown: "Conclusioni delle parti" },
      ]),
    );
    const enriched = await enrichExtractedPdfText(
      samplePdf,
      { text: "", textlessPageCount: 2 },
      mistralCfg,
      fetchMock as unknown as typeof fetch,
    );
    expect(enriched).toEqual({
      text: "[Page 1]\nAtto di citazione\n\n[Page 2]\nConclusioni delle parti",
      textlessPageCount: 0,
      ocrPageCount: 2,
    });
  });

  it("falls back to original pdf.js output on HTTP or network failure without throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    const original = { text: "", textlessPageCount: 2 };
    const enriched = await enrichExtractedPdfText(
      samplePdf,
      original,
      mistralCfg,
      fetchMock as unknown as typeof fetch,
    );
    expect(enriched.text).toBe("");
    expect(enriched.textlessPageCount).toBe(2);
    expect(enriched.ocrPageCount).toBe(0);
    expect(enriched.error?.kind).toBe("ocr.http_failed");
  });

  it("ignores out-of-range or blank OCR page entries", () => {
    const merged = mergeOcrIntoPdfPages(
      ["[Page 1]\n", "[Page 2]\n"],
      [
        { index: 0, text: "   " },
        { index: 1, text: "Pagina due" },
        { index: 9, text: "Fuori range" },
      ],
      5,
    );
    expect(merged.text).toBe("[Page 1]\n\n\n[Page 2]\nPagina due");
    expect(merged.textlessPageCount).toBe(1);
    expect(merged.ocrPageCount).toBe(1);
  });
});

describe("OCR review hardening", () => {
  it("never replaces a native page that was not requested", () => {
    const merged = mergeOcrIntoPdfPages(
      ["[Page 1]\nNative clause on page one", "[Page 2]\n"],
      [
        { index: 0, text: "Model rewrite of page one" },
        { index: 1, text: "Scanned page two" },
      ],
      25,
      [1],
    );
    expect(merged.text).toBe("[Page 1]\nNative clause on page one\n\n[Page 2]\nScanned page two");
    expect(merged.ocrPageCount).toBe(1);
  });

  it("keeps short native text when OCR returns no usable pages", () => {
    const merged = mergeOcrIntoPdfPages(["[Page 1]\nCase 123", "[Page 2]\n"], [], 25, [0, 1]);
    expect(merged.text).toBe("[Page 1]\nCase 123\n\n[Page 2]\n");
    expect(merged.ocrPageCount).toBe(0);
  });

  it("keeps short native text even when OCR returns text for that page", () => {
    const merged = mergeOcrIntoPdfPages(
      ["[Page 1]\nCase 123", "[Page 2]\n"],
      [
        { index: 0, text: "OCR rewrite of page one" },
        { index: 1, text: "Scanned page two" },
      ],
      25,
      [0, 1],
    );
    expect(merged.text).toBe("[Page 1]\nCase 123\n\n[Page 2]\nScanned page two");
    expect(merged.ocrPageCount).toBe(1);
  });

  it("rejects an unmarked multi-page chat response instead of misattributing it", async () => {
    const cfg = readOcrConfig({
      OCR_BASE_URL: "https://ocr.example.test/v1",
      OCR_API_KEY: "k",
      OCR_PROTOCOL: "openai-chat",
    });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Text of two pages without markers" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    await expect(ocrPdfPages(samplePdf, [0, 1], cfg, fetchImpl)).rejects.toMatchObject({
      kind: "ocr.invalid_response",
    });
  });

  it("still maps an unmarked response to the page when one page is requested", async () => {
    const cfg = readOcrConfig({
      OCR_BASE_URL: "https://ocr.example.test/v1",
      OCR_API_KEY: "k",
      OCR_PROTOCOL: "openai-chat",
    });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Only page" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    await expect(ocrPdfPages(samplePdf, [2], cfg, fetchImpl)).resolves.toEqual([{ index: 2, text: "Only page" }]);
  });

  it("keeps the original extraction when OCR adds nothing", async () => {
    const cfg = readOcrConfig({ MISTRAL_API_KEY: "k" });
    const extracted = { text: "[Page 1]\nSigned\n\n[Page 2]\n", textlessPageCount: 1 };
    const fetchImpl = vi.fn(async () => mistralJsonResponse([])) as unknown as typeof fetch;
    const result = await enrichExtractedPdfText(samplePdf, extracted, cfg, fetchImpl);
    expect(result.text).toBe(extracted.text);
    expect(result.ocrPageCount).toBe(0);
  });

  it("rejects a chat completion truncated at the token limit", async () => {
    const cfg = readOcrConfig({
      OCR_BASE_URL: "https://ocr.example.test/v1",
      OCR_API_KEY: "k",
      OCR_PROTOCOL: "openai-chat",
    });
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "[Page 1]\npartial" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const result = await enrichExtractedPdfText(samplePdf, { text: "", textlessPageCount: 1 }, cfg, fetchImpl);
    expect(result.error?.kind).toBe("ocr.truncated");
    expect(result.text).toBe("");
  });

  it("does not send Azure credentials without an Azure endpoint", () => {
    const noEndpoint = readOcrConfig({ OCR_PROVIDER: "azure", AZURE_API_KEY: "azure-key" });
    expect(noEndpoint.apiKey).toBeUndefined();
    expect(ocrEnabled(noEndpoint)).toBe(false);
    const foreign = readOcrConfig({
      OCR_PROVIDER: "azure",
      OCR_API_URL: "https://ocr.example.test/v1/chat/completions",
      AZURE_API_KEY: "azure-key",
    });
    expect(foreign.apiKey).toBeUndefined();
    const azure = readOcrConfig({
      OCR_PROVIDER: "azure",
      OCR_API_URL: "https://studio.openai.azure.com/openai/deployments/vision/chat/completions",
      AZURE_API_KEY: "azure-key",
    });
    expect(azure.apiKey).toBe("azure-key");
  });

  it("sends the Mistral key only to a Mistral host", () => {
    const openAiDefault = readOcrConfig({ OCR_PROTOCOL: "openai-chat", MISTRAL_API_KEY: "m" });
    expect(openAiDefault.url).toContain("api.openai.com");
    expect(openAiDefault.apiKey).toBeUndefined();
    expect(readOcrConfig({ MISTRAL_API_KEY: "m" }).apiKey).toBe("m");
  });
});

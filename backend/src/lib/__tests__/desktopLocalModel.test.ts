import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider } from "../llm/providers";
import { desktopStarterRequestBody } from "../llm/desktopStarter";

function captureCompletion() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "Done" },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("managed desktop Ollama preset", () => {
  it.each(["qwen3.5:2b", "qwen3.5:4b"])(
    "requests no thinking for managed %s",
    async (tag) => {
      vi.stubEnv("MIKE_DESKTOP_LOCAL_MODEL", tag);
      vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:42816/v1");
      const fetchMock = captureCompletion();
      await completeWithProvider({
        model: `ollama/${tag}`,
        user: "Hello",
        maxTokens: 64,
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("http://127.0.0.1:42816/v1/chat/completions");
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
        model: tag,
        reasoning_effort: "none",
        temperature: 0,
        max_tokens: 64,
      });
    },
  );

  it.each([
    ["", "qwen3.5:4b", "http://localhost:11434/v1"],
    ["qwen3.5:4b", "qwen3.5:2b", "http://localhost:42816/v1"],
    ["qwen3.5:4b", "qwen3.5:4b", "https://ollama.example.test/v1"],
    ["qwen3.5:4b", "qwen3.5:4b", "https://localhost.example.test/v1"],
    ["another-model", "another-model", "http://localhost:42816/v1"],
  ])(
    "preserves normal behavior for managed=%s model=%s endpoint=%s",
    async (managed, tag, baseURL) => {
      vi.stubEnv("MIKE_DESKTOP_LOCAL_MODEL", managed);
      vi.stubEnv("OLLAMA_BASE_URL", baseURL);
      const fetchMock = captureCompletion();
      await completeWithProvider({
        model: `ollama/${tag}`,
        user: "Hello",
        maxTokens: 64,
      });
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("temperature");
    },
  );

  it("preserves explicit caller temperature and all unrelated request fields", () => {
    const body = { model: "qwen3.5:2b", temperature: 0.4, max_tokens: 64 };
    expect(desktopStarterRequestBody(body)).toEqual({ ...body, reasoning_effort: "none" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

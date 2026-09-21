import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiGatewayError, firstMessage, openRouterChat, openRouterConfigured } from "./openRouterChat";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

describe("openRouterChat", () => {
  it("posts an OpenAI-style chat completion with the bearer key and returns parsed JSON", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 }));
    const res = await openRouterChat({ model: "google/gemini-2.5-pro", messages: [{ role: "user", content: "x" }], temperature: 0.1 });
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(firstMessage(res.json)?.content).toBe("hi");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "google/gemini-2.5-pro", temperature: 0.1 });
  });

  it("returns non-ok responses with their error text instead of throwing", async () => {
    fetchMock.mockResolvedValue(new Response("quota exceeded", { status: 402 }));
    const res = await openRouterChat({ model: "m", messages: [] });
    expect(res).toEqual({ ok: false, status: 402, json: null, errorText: "quota exceeded" });
  });

  it("fails fast when the key is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(openRouterConfigured()).toBe(false);
    await expect(openRouterChat({ model: "m", messages: [] })).rejects.toBeInstanceOf(AiGatewayError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("firstMessage tolerates malformed bodies", () => {
    expect(firstMessage(null)).toBeNull();
    expect(firstMessage({ choices: [] })).toBeNull();
    expect(firstMessage({ choices: [{ message: "nope" }] })).toBeNull();
  });
});

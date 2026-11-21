import { afterEach, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "./providers";
import { isDeterministicProviderQuota, providerFailureKind } from "./providerErrors";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each([
  ['{"error":{"code":"insufficient_quota","type":"insufficient_quota","message":"PRIVATE_ACCOUNT"}}', 1, true],
  ['{"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}', 3, false],
])("applies quota verdict before completion and streaming SDK retries: %s", async (body, attempts, deterministic) => {
  const fetch = vi.fn(async () => new Response(body as string, { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } }));
  vi.stubGlobal("fetch", fetch);
  const apiKeys = { xai: "test-key", keySources: { xai: "env" as const } };
  const completionError = await completeWithProvider({ model: "xai/grok-4.3", user: "hello", apiKeys }).catch(error => error);
  expect(fetch).toHaveBeenCalledTimes(attempts as number);
  expect(isDeterministicProviderQuota(completionError)).toBe(deterministic);
  fetch.mockClear();
  const streamError = await streamWithProvider({ model: "xai/grok-4.3", systemPrompt: "", messages: [{ role: "user", content: "hello" }], apiKeys }).catch(error => error);
  expect(fetch).toHaveBeenCalledTimes(attempts as number);
  expect(isDeterministicProviderQuota(streamError)).toBe(deterministic);
  expect(providerFailureKind(streamError)).toBe(deterministic ? "chat.provider_out_of_credits" : "chat.provider_rate_limited");
});
it("does not retry Gemini's zero-limit plan refusal", async () => {
  const fetch = vi.fn(async () => Response.json({ error: { code: 429, message: "Quota exceeded, limit: 0, model: private", status: "RESOURCE_EXHAUSTED" } }, { status: 429 }));
  vi.stubGlobal("fetch", fetch);
  const error = await streamWithProvider({ model: "gemini-3-flash-preview", systemPrompt: "", messages: [{ role: "user", content: "hello" }], apiKeys: { gemini: "test-key" } }).catch(error => error);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(providerFailureKind(error)).toBe("chat.provider_rejected");
  expect(error.message).toMatch(/upgrade/);
});

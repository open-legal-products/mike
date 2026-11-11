import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
vi.mock("../mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
import { resetSentryForTests, scrubEvent } from "../observability/sentry";
import { privacyBoundaryIntegration } from "../observability/sentryPrivacy";
import { runLLMStream, AssistantStreamError, assistantStreamErrorPayload } from "../../modules/chat/engine/streaming";
import { logProviderWarnings, resetProviderWarningsForTests } from "./warnings";
import { resetModelRegistryCache } from "./registry";

let sent: Sentry.Event[];
beforeEach(() => {
  sent = [];
  resetSentryForTests("official", { initialized: true });
  resetProviderWarningsForTests();
  Sentry.init({
    dsn: "https://test@sentry.invalid/1", defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), privacyBoundaryIntegration()],
    beforeSend: scrubEvent,
    transport: () => ({ send: async envelope => {
      for (const [header, payload] of envelope[1]) if (header.type === "event") sent.push(payload as Sentry.Event);
      return { statusCode: 200 };
    }, flush: async () => true }),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => { await Sentry.close(); resetSentryForTests(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetModelRegistryCache(); vi.restoreAllMocks(); });
function emptyDb() {
  const q: Record<string, unknown> = {};
  for (const key of ["from", "select", "eq", "filter", "order", "in", "is", "limit"]) q[key] = () => q;
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
  q.maybeSingle = async () => ({ data: null, error: null });
  return q;
}
it.each([
  [404, "model not found: PRIVATE_MODEL", "user", 0],
  [403, "You do not have access to model PRIVATE_MODEL", "user", 0],
  [403, "PRIVATE_REGION_OR_WAF_BLOCK", "user", 1],
  [403, "Unauthorized", "user", 1],
  [404, "model not found: PRIVATE_MODEL", "deployment", 1],
  [429, "Quota exceeded: limit: 0, PRIVATE_ACCOUNT", "deployment", 1],
  [429, "Quota exceeded: limit: 0, PRIVATE_ACCOUNT", "user", 0],
] as const)("final stream envelope ownership for %s %s (%s)", async (status, message, source, count) => {
  const fetch = vi.fn(async () => Response.json({ error: { code: status, message, status: "PERMISSION_DENIED" } }, { status, headers: { "retry-after-ms": "1" } }));
  vi.stubGlobal("fetch", fetch);
  const error = await runLLMStream({
    apiMessages: [{ role: "user", content: "hello" }], docStore: new Map(), docIndex: {}, userId: "test-user",
    db: emptyDb() as never, write: vi.fn(), model: "gemini-3-flash-preview",
    apiKeys: { gemini: "PRIVATE_KEY", keySources: { gemini: source === "deployment" ? "env" : "user" } }, emitDone: false,
  }).catch(error => error);
  expect(error).toBeInstanceOf(AssistantStreamError);
  expect(assistantStreamErrorPayload(error).reporting_owner).toBe("backend");
  expect(fetch).toHaveBeenCalledTimes(1);
  await Sentry.flush(2000);
  expect(sent).toHaveLength(count);
  if (count) expect(sent[0]?.level).toBe("error");
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_");
});
it("reports a locally authored missing-key instruction at warning", async () => {
  vi.stubEnv("GEMINI_API_KEY", "");
  const error = await runLLMStream({
    apiMessages: [{ role: "user", content: "hello" }], docStore: new Map(), docIndex: {}, userId: "test-user",
    db: emptyDb() as never, write: vi.fn(), model: "gemini-3-flash-preview", apiKeys: {}, emitDone: false,
  }).catch(error => error);
  expect(error).toBeInstanceOf(AssistantStreamError);
  await Sentry.flush(2000);
  expect(sent.map(event => event.level)).toEqual(["warning"]);
});
it.each([
  ["", {}],
  ["model-that-is-not-available", {}],
  ["gemini-3-flash-preview", { disabledProviders: ["gemini"] }],
  ["openrouter/provider/unselected-model", { openrouter: "PRIVATE_KEY" }],
] as const)("reports the source-owned model configuration refusal at warning: %s", async (model, keys) => {
  const fetch = vi.fn(() => { throw new Error("Provider must not be contacted for a configuration refusal"); });
  vi.stubGlobal("fetch", fetch);
  const error = await runLLMStream({
    apiMessages: [{ role: "user", content: "hello" }], docStore: new Map(), docIndex: {}, userId: "test-user",
    db: emptyDb() as never, write: vi.fn(), model, apiKeys: keys as never, emitDone: false,
  }).catch(error => error);
  expect(error).toBeInstanceOf(AssistantStreamError);
  expect(fetch).not.toHaveBeenCalled();
  expect(assistantStreamErrorPayload(error).reporting_owner).toBe("backend");
  await Sentry.flush(2000);
  expect(sent.map(event => event.level)).toEqual(["warning"]);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_");
});

it("reports a disabled configured model provider at warning in the final envelope", async () => {
  vi.stubEnv("MIKE_MODEL_CONFIG_JSON", JSON.stringify({ models: [{
    id: "configured-review-model", provider: "openai-compatible", location: "cloud",
    baseUrl: "https://provider.example/v1", apiKeyProvider: "openai",
  }] }));
  resetModelRegistryCache();
  const fetch = vi.fn(() => { throw new Error("Provider must not be contacted"); });
  vi.stubGlobal("fetch", fetch);
  const error = await runLLMStream({
    apiMessages: [{ role: "user", content: "hello" }], docStore: new Map(), docIndex: {}, userId: "test-user",
    db: emptyDb() as never, write: vi.fn(), model: "configured-review-model", apiKeys: { disabledProviders: ["openai"] }, emitDone: false,
  }).catch(error => error);
  expect(error).toBeInstanceOf(AssistantStreamError);
  expect(error.message).toMatch(/turned off/);
  expect(fetch).not.toHaveBeenCalled();
  await Sentry.flush(2000);
  expect(sent.map(event => event.level)).toEqual(["warning"]);
});

it("sends distinct known deprecation diagnoses through the final privacy boundary", async () => {
  for (let i = 0; i < 5; i++) logProviderWarnings({ warnings: [{ type: "deprecated", setting: "generateObject", message: "PRIVATE_NOTICE" }] });
  logProviderWarnings({ warnings: [{ type: "deprecated", setting: "streamObject", message: "PRIVATE_NOTICE" }] });
  await Sentry.flush(2000);
  expect(sent).toHaveLength(2);
  expect(sent.map(event => event.tags?.warning_code)).toEqual(["AISDK_DEP_GENERATE_OBJECT", "AISDK_DEP_STREAM_OBJECT"]);
  expect(sent.every(event => event.exception?.values?.some(value => value.stacktrace?.frames?.length))).toBe(true);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_");
});

import { afterEach, expect, it, vi } from "vitest";
import { streamAiSdk } from "./aiSdk";
import { config, textStep } from "./__tests__/mockLanguageModel";
import { UserFacingError } from "../userFacingError";

afterEach(() => vi.unstubAllEnvs());
const params = {
  model: "m",
  systemPrompt: "S",
  messages: [{ role: "user" as const, content: "go" }],
};

it("first-output deadline also covers waiting for provider response headers", async () => {
  vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
  vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
  const { MockLanguageModelV3 } = await import("ai/test");
  const model = new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 11000);
        abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(abortSignal.reason);
          },
          { once: true },
        );
      });
      return textStep("late success");
    },
  });
  await expect(streamAiSdk(params, config(model))).rejects.toBeInstanceOf(
    UserFacingError,
  );
}, 15000);

it("metadata alone does not reset the first-output deadline", async () => {
  vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
  const { MockLanguageModelV3 } = await import("ai/test");
  const model = new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "response-metadata",
            id: "r",
            modelId: "m",
          });
          abortSignal?.addEventListener(
            "abort",
            () => controller.error(abortSignal.reason),
            { once: true },
          );
        },
      }),
    }),
  });
  await expect(streamAiSdk(params, config(model))).rejects.toThrow(
    /stopped responding/,
  );
}, 15000);

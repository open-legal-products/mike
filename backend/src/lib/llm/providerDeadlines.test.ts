import { afterEach, expect, it, vi } from "vitest";
import { streamAiSdk } from "./aiSdk";
import {
  callStep,
  config,
  makeModel,
  okRunTools,
  textStep,
  TOOLS,
} from "./__tests__/mockLanguageModel";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("a healthy tool may take longer than the model chunk timeout", async () => {
  vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
  vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
  const model = await makeModel([
    callStep("c1", "read_document", { doc_id: "doc-0" }),
    textStep("done"),
  ]);
  const result = await streamAiSdk(
    {
      model: "m",
      systemPrompt: "S",
      messages: [{ role: "user", content: "go" }],
      tools: TOOLS,
      runTools: async (calls) => {
        await new Promise((resolve) => setTimeout(resolve, 6500));
        return okRunTools(calls);
      },
    },
    config(model),
  );
  expect(result.fullText).toBe("done");
}, 15000);

it("ends a stalled provider read even when the provider ignores abort", async () => {
  const { MockLanguageModelV3 } = await import("ai/test");
  vi.useFakeTimers();
  vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
  const cancel = vi.fn();
  const activity = vi.fn();
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "partial" });
        },
        cancel,
      }),
    }),
  });
  const pending = streamAiSdk(
    {
      model: "m",
      systemPrompt: "S",
      messages: [{ role: "user", content: "go" }],
      callbacks: { onActivity: activity },
    },
    config(model),
  );
  const assertion = expect(pending).rejects.toThrow(/stopped responding/);
  await vi.advanceTimersByTimeAsync(5001);
  await assertion;
  expect(activity).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a provider response that arrives after the first-output deadline", async () => {
  const { MockLanguageModelV3 } = await import("ai/test");
  vi.useFakeTimers();
  vi.stubEnv("STREAM_FIRST_CHUNK_TIMEOUT_MS", "10000");
  const cancel = vi.fn();
  let resolveHeaders!: (value: { stream: ReadableStream }) => void;
  const model = new MockLanguageModelV3({
    doStream: () =>
      new Promise((resolve) => {
        resolveHeaders = resolve;
      }),
  });
  const pending = streamAiSdk(
    {
      model: "m",
      systemPrompt: "S",
      messages: [{ role: "user", content: "go" }],
    },
    config(model),
  );
  const assertion = expect(pending).rejects.toThrow(/stopped responding/);
  await vi.advanceTimersByTimeAsync(10001);
  await assertion;
  resolveHeaders({ stream: new ReadableStream({ cancel }) });
  await vi.advanceTimersByTimeAsync(1);
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps healthy slow provider output alive and clears timers on completion", async () => {
  const { MockLanguageModelV3 } = await import("ai/test");
  const { finish } = await import("./__tests__/mockLanguageModel.js");
  vi.useFakeTimers();
  vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "5000");
  let controller!: ReadableStreamDefaultController;
  const cancel = vi.fn();
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel,
      }),
    }),
  });
  const pending = streamAiSdk(
    {
      model: "m",
      systemPrompt: "S",
      messages: [{ role: "user", content: "go" }],
    },
    config(model),
  );
  await vi.advanceTimersByTimeAsync(1);
  controller.enqueue({ type: "text-start", id: "t" });
  for (let i = 0; i < 5; i++) {
    controller.enqueue({ type: "text-delta", id: "t", delta: "x" });
    await vi.advanceTimersByTimeAsync(4000);
  }
  controller.enqueue({ type: "text-end", id: "t" });
  controller.enqueue(finish("stop"));
  // Even a provider that forgets EOF after its terminal event is released.
  await expect(pending).resolves.toEqual({ fullText: "xxxxx" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

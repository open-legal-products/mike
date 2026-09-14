/**
 * Shared stub-LanguageModel scaffolding for aiSdk.ts tests: no network, no
 * keys — a MockLanguageModelV3 scripts each model step's stream parts and
 * records the prompt the SDK sent for each step (`model.doStreamCalls`).
 */
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";

import type { AiSdkAdapterConfig } from "../aiSdk";
import type {
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
} from "../types";

export type Part = Record<string, unknown>;

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export const finish = (reason: "stop" | "tool-calls" | "length"): Part => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage,
});

export const text = (t: string, id = "t0"): Part[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: t },
  { type: "text-end", id },
];

/** A raw tool call as the provider would stream it; `input` is the JSON text
 *  (pass a string to script malformed JSON). */
export const toolCall = (id: string, name: string, input: unknown): Part => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: typeof input === "string" ? input : JSON.stringify(input),
});

/** One scripted model step. */
export const step = (...parts: Part[]) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "resp", modelId: "mock" },
    ...parts,
  ]),
});

export const textStep = (t: string) => step(...text(t), finish("stop"));

export const callStep = (
  id: string,
  name: string,
  input: unknown,
  pre: Part[] = [],
) => step(...pre, toolCall(id, name, input), finish("tool-calls"));

export const TOOLS: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_document",
      description: "Read a document.",
      parameters: {
        type: "object",
        properties: { doc_id: { type: "string" } },
      },
    },
  },
];

export function makeModel(steps: Array<ReturnType<typeof step>>) {
  return new MockLanguageModelV3({
    doStream: async () => {
      const s = steps.shift();
      if (!s) throw new Error("mock model: no more scripted steps");
      return s;
    },
  });
}

export function config(model: MockLanguageModelV3): AiSdkAdapterConfig {
  return {
    provider: "ollama",
    label: "Mock",
    model: model as never,
    modelId: "mock-model",
    supportsReasoning: false,
  };
}

export const okRunTools = async (
  calls: NormalizedToolCall[],
): Promise<NormalizedToolResult[]> =>
  calls.map((c) => ({
    tool_use_id: c.id,
    content: JSON.stringify({ ok: true, text: `doc ${c.name}` }),
  }));

/** Let any background SDK step the consumer no longer awaits run. */
export const tick = () => new Promise((r) => setTimeout(r, 30));

/**
 * Mirror of the module-private class in lib/chat/streaming.ts. The ask_inputs
 * tool ends the turn by throwing this from inside runTools; streaming.ts
 * recognises it with `err instanceof AssistantStreamAskInputsPause`, so the
 * adapter must hand back the very same instance.
 */
export class AssistantStreamAskInputsPause extends Error {
  constructor() {
    super("Waiting for user input.");
    this.name = "AssistantStreamAskInputsPause";
  }
}

/** streaming.ts's isAbortError heuristics, replicated verbatim: an error
 *  satisfying this takes the silent user-cancel path. */
export const readsAsCancel = (e: unknown) => {
  const rec = e as { name?: unknown; message?: unknown };
  return rec.name === "AbortError" || rec.message === "Stream aborted.";
};

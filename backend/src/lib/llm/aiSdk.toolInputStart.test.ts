/**
 * A tool call is announced when the model starts writing it, before its
 * arguments have streamed, so the client can show the step while a long input
 * (cite_sources with every quote) is still being generated.
 */
import { describe, expect, it } from "vitest";

import { streamAiSdk } from "./aiSdk";
import {
  TOOLS,
  config,
  finish,
  makeModel,
  okRunTools,
  step,
  textStep,
  toolCall,
} from "./__tests__/mockLanguageModel";

describe("tool input start", () => {
  it("reports a call when its input starts, then again once it is complete", async () => {
    const input = JSON.stringify({ doc_id: "doc-0" });
    const model = await makeModel([
      step(
        { type: "tool-input-start", id: "c1", toolName: "read_document" },
        { type: "tool-input-delta", id: "c1", delta: input },
        { type: "tool-input-end", id: "c1" },
        toolCall("c1", "read_document", input),
        finish("tool-calls"),
      ),
      textStep("done"),
    ]);
    const seen: string[] = [];
    await streamAiSdk(
      {
        model: "m",
        systemPrompt: "S",
        messages: [{ role: "user", content: "go" }],
        tools: TOOLS,
        maxIterations: 5,
        callbacks: {
          onToolInputStart: (call) => seen.push(`input:${call.id}:${call.name}`),
          onToolCallStart: (call) =>
            seen.push(`call:${call.id}:${JSON.stringify(call.input)}`),
        },
        runTools: async (calls) => {
          seen.push("run");
          return okRunTools(calls);
        },
      },
      config(model),
    );
    expect(seen).toEqual([
      "input:c1:read_document",
      `call:c1:${input}`,
      "run",
    ]);
  });
});

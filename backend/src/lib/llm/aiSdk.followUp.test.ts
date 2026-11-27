/**
 * Stub-LanguageModel tests for the follow-up step streamAiSdk runs after a
 * finished answer when `params.followUp` asks for one: one more step in the
 * same conversation, in which only the named tool runs and nothing the
 * model writes reaches the answer.
 */
import { describe, expect, it, vi } from "vitest";

import { streamAiSdk } from "./aiSdk";
import type { NormalizedToolCall, OpenAIToolSchema } from "./types";
import {
  callStep,
  config,
  finish,
  makeModel,
  okRunTools,
  step,
  text,
  textStep,
  tick,
  toolCall,
  TOOLS,
} from "./__tests__/mockLanguageModel";

const CITE: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "cite_sources",
    description: "Record citations.",
    parameters: { type: "object", properties: { citations: { type: "array" } } },
  },
};

const FOLLOW_UP = { tool: "cite_sources", instruction: "Record [1] now." };

const base = {
  model: "m",
  systemPrompt: "S",
  messages: [{ role: "user" as const, content: "go" }],
  tools: [...TOOLS, CITE],
  maxIterations: 5,
};

const citeInput = { citations: [{ ref: 1 }] };

describe("follow-up step", () => {
  it("runs only its tool, after the answer, and keeps its text out of the answer", async () => {
    const model = await makeModel([
      textStep("Answer [1]."),
      step(...text("Recording now."), toolCall("late", "cite_sources", citeInput), finish("tool-calls")),
    ]);
    const batches: NormalizedToolCall[][] = [];
    const callbacks = { onContentDelta: vi.fn(), onToolCallStart: vi.fn() };
    const followUp = vi.fn(() => FOLLOW_UP);

    const result = await streamAiSdk(
      {
        ...base,
        followUp,
        callbacks,
        runTools: async (calls) => {
          batches.push(calls);
          return okRunTools(calls);
        },
      },
      config(model),
    );

    expect(followUp).toHaveBeenCalledExactlyOnceWith("Answer [1].");
    expect(result.fullText).toBe("Answer [1].");
    expect(callbacks.onContentDelta.mock.calls).toEqual([["Answer [1]."]]);
    expect(callbacks.onToolCallStart).toHaveBeenCalledExactlyOnceWith({
      id: "late", name: "cite_sources", input: citeInput,
    });
    expect(batches).toEqual([[{ id: "late", name: "cite_sources", input: citeInput }]]);
    // The step continues the conversation: the answer, then the instruction.
    const prompt = model.doStreamCalls[1].prompt;
    expect(prompt.at(-2)).toMatchObject({
      role: "assistant", content: [{ type: "text", text: "Answer [1]." }],
    });
    expect(prompt.at(-1)).toMatchObject({
      role: "user", content: [{ type: "text", text: FOLLOW_UP.instruction }],
    });
    // Every tool is still defined, so earlier calls stay valid history.
    expect(model.doStreamCalls[1].tools?.map((t) => t.name)).toEqual(["read_document", "cite_sources"]);
    // The tool's result is not sent back to the model for another turn.
    await tick();
    expect(model.doStreamCalls.length).toBe(2);
  });

  it("does not run any other tool the model calls in that step", async () => {
    const model = await makeModel([
      textStep("Answer [1]."),
      callStep("other", "read_document", { doc_id: "doc-0" }),
    ]);
    const runTools = vi.fn(okRunTools);
    const onToolCallStart = vi.fn();

    const result = await streamAiSdk(
      { ...base, followUp: () => FOLLOW_UP, runTools, callbacks: { onToolCallStart } },
      config(model),
    );

    expect(result.fullText).toBe("Answer [1].");
    expect(runTools).not.toHaveBeenCalled();
    expect(onToolCallStart).not.toHaveBeenCalled();
  });

  it("reports only its own tool when the model starts writing a call", async () => {
    const model = await makeModel([
      textStep("Answer [1]."),
      step(
        { type: "tool-input-start", id: "other", toolName: "read_document" },
        { type: "tool-input-end", id: "other" },
        toolCall("other", "read_document", { doc_id: "doc-0" }),
        { type: "tool-input-start", id: "late", toolName: "cite_sources" },
        { type: "tool-input-end", id: "late" },
        toolCall("late", "cite_sources", citeInput),
        finish("tool-calls"),
      ),
    ]);
    const onToolInputStart = vi.fn();

    await streamAiSdk(
      { ...base, followUp: () => FOLLOW_UP, runTools: okRunTools, callbacks: { onToolInputStart } },
      config(model),
    );

    expect(onToolInputStart).toHaveBeenCalledExactlyOnceWith({ id: "late", name: "cite_sources" });
  });

  it("runs no step when the check asks for nothing", async () => {
    const model = await makeModel([textStep("Answer.")]);

    await streamAiSdk(
      { ...base, followUp: () => null, runTools: okRunTools },
      config(model),
    );

    await tick();
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("does not check an answer cut off at the output limit", async () => {
    const model = await makeModel([step(...text("Answer [1] that was cut"), finish("length"))]);
    const followUp = vi.fn(() => FOLLOW_UP);

    await streamAiSdk({ ...base, followUp, runTools: okRunTools }, config(model));

    expect(followUp).not.toHaveBeenCalled();
    expect(model.doStreamCalls.length).toBe(1);
  });

  it("keeps the finished answer when the follow-up step fails", async () => {
    const model = await makeModel([textStep("Answer [1]."), new Error("provider down")]);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await streamAiSdk(
      { ...base, followUp: () => FOLLOW_UP, runTools: okRunTools },
      config(model),
    );

    expect(result.fullText).toBe("Answer [1].");
    expect(warned).toHaveBeenCalledWith(
      "[llm/follow-up] follow-up step failed; answer kept",
      { provider: "ollama", category: expect.any(String) },
    );
    warned.mockRestore();
  });

  it("still ends the turn when the user stops it during the follow-up step", async () => {
    const controller = new AbortController();
    const model = await makeModel([textStep("Answer [1]."), callStep("late", "cite_sources", citeInput)]);

    await expect(
      streamAiSdk(
        {
          ...base,
          abortSignal: controller.signal,
          followUp: () => FOLLOW_UP,
          runTools: async (calls) => {
            controller.abort();
            return okRunTools(calls);
          },
        },
        config(model),
      ),
    ).rejects.toThrow();
  });
});

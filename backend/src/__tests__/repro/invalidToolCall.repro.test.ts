/**
 * Regression test for: an invalid tool call ended the whole turn (reproduced
 * on dd91a85).
 *
 * ai@7 handles a tool call it cannot dispatch — unknown tool name
 * (NoSuchToolError) or unparseable JSON input (InvalidToolInputError) — by
 * emitting a `tool-error` part flagged `dynamic: true`, queuing that error
 * text as the call's tool result, and CONTINUING the step loop so the model
 * can recover. aiSdk.ts used to throw on every `tool-error` part, so the
 * recovery never happened: on pristine dd91a85 streamAiSdk rejected with
 * `Error("Model tried to call unavailable tool 'nonexistent_tool'. …")` /
 * `Error("Invalid input for tool read_document: …")` while the SDK had already
 * requested step 2 behind the dead stream.
 *
 * The first describe pins the SDK premise offline; the second is the adapter
 * contract.
 */
import { describe, expect, it } from "vitest";

import { streamAiSdk } from "../../lib/llm/aiSdk";
import {
  callStep,
  config,
  makeModel,
  okRunTools,
  textStep,
  TOOLS,
} from "../../lib/llm/__tests__/mockLanguageModel";

const base = {
  model: "m",
  systemPrompt: "S",
  messages: [{ role: "user" as const, content: "go" }],
  tools: TOOLS,
  maxIterations: 5,
};

describe("SDK premise — ai@7 marks undispatchable tool calls as dynamic tool-error parts and continues", () => {
  async function collectParts(scripted: ReturnType<typeof callStep>[]) {
    const sdk = await import("ai");
    const model = makeModel(scripted);
    const tools = Object.fromEntries(
      TOOLS.map((schema) => [
        schema.function.name,
        sdk.tool({
          description: schema.function.description,
          inputSchema: sdk.jsonSchema<Record<string, unknown>>(
            schema.function.parameters as never,
          ),
          execute: async () => "ok",
        } as never),
      ]),
    );
    const result = sdk.streamText({
      model: model as never,
      messages: base.messages,
      tools,
      stopWhen: sdk.stepCountIs(5),
    });
    const parts: Array<Record<string, unknown>> = [];
    for await (const part of result.stream) {
      parts.push(part as Record<string, unknown>);
    }
    return { parts, model, text: await result.text };
  }

  it("unknown tool name → tool-error {dynamic:true}, error text fed back, next step runs", async () => {
    const { parts, model, text } = await collectParts([
      callStep("c1", "nonexistent_tool", { x: 1 }),
      textStep("recovered"),
    ]);
    const toolError = parts.find((p) => p.type === "tool-error");
    expect(toolError).toMatchObject({
      toolCallId: "c1",
      toolName: "nonexistent_tool",
      dynamic: true,
    });
    expect(String(toolError?.error)).toMatch(
      /unavailable tool 'nonexistent_tool'.*Available tools: read_document/,
    );
    expect(text).toBe("recovered");
    expect(model.doStreamCalls.length).toBe(2);
    // The error is what the model sees as the call's result on step 2.
    const prompt2 = JSON.stringify(
      (model.doStreamCalls[1] as { prompt: unknown }).prompt,
    );
    expect(prompt2).toContain("unavailable tool 'nonexistent_tool'");
    expect(prompt2).toContain('"toolCallId":"c1"');
  });

  it("unparseable tool input → tool-error {dynamic:true}, next step runs", async () => {
    const { parts, model, text } = await collectParts([
      callStep("c1", "read_document", '{"doc_id": "doc-0"'),
      textStep("recovered"),
    ]);
    const toolError = parts.find((p) => p.type === "tool-error");
    expect(toolError).toMatchObject({
      toolCallId: "c1",
      toolName: "read_document",
      dynamic: true,
    });
    expect(String(toolError?.error)).toMatch(/Invalid input for tool read_document/);
    expect(text).toBe("recovered");
    expect(model.doStreamCalls.length).toBe(2);
  });
});

describe("streamAiSdk on an SDK-synthesized (dynamic) tool-error", () => {
  it("unknown tool name: the loop continues, the dispatcher never sees the call, the recovery text is returned", async () => {
    const model = makeModel([
      callStep("c1", "nonexistent_tool", { x: 1 }),
      textStep("recovered"),
    ]);
    const dispatched: string[] = [];
    const res = await streamAiSdk(
      {
        ...base,
        runTools: async (calls) => {
          dispatched.push(...calls.map((c) => c.name));
          return okRunTools(calls);
        },
      },
      config(model),
    );
    expect(res.fullText).toBe("recovered");
    expect(dispatched).toEqual([]);
    expect(model.doStreamCalls.length).toBe(2);
    const prompt2 = JSON.stringify(
      (model.doStreamCalls[1] as { prompt: unknown }).prompt,
    );
    expect(prompt2).toContain("unavailable tool 'nonexistent_tool'");
  });

  it("unparseable tool input: the loop continues the same way", async () => {
    const model = makeModel([
      callStep("c1", "read_document", '{"doc_id": "doc-0"'),
      textStep("recovered"),
    ]);
    const res = await streamAiSdk(
      { ...base, runTools: okRunTools },
      config(model),
    );
    expect(res.fullText).toBe("recovered");
    expect(model.doStreamCalls.length).toBe(2);
  });
});

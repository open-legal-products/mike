/**
 * Stub-LanguageModel tests for the provider's own web search in streamAiSdk:
 * the stream parts a provider-run search produces (as @ai-sdk/anthropic and
 * @ai-sdk/openai emit them) and how they reach onWebSearch. No network.
 */
import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_WEB_SEARCH_TOOL,
  streamAiSdk,
} from "./aiSdk";
import type { ProviderWebSearchEvent } from "./types";
import {
  config,
  finish,
  makeModel,
  okRunTools,
  step,
  text,
  toolCall,
  TOOLS,
  type Part,
} from "./__tests__/mockLanguageModel";

const base = {
  model: "m",
  systemPrompt: "S",
  messages: [{ role: "user" as const, content: "go" }],
  maxIterations: 5,
};

async function anthropicSearch() {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({ apiKey: "test" });
  return ({ maxUses }: { maxUses: number }) =>
    anthropic.tools.webSearch_20250305({ maxUses });
}

const searchCall = (id: string, input: unknown = { query: "uk ai act" }): Part => ({
  type: "tool-call",
  toolCallId: id,
  toolName: PROVIDER_WEB_SEARCH_TOOL,
  input: JSON.stringify(input),
  providerExecuted: true,
});

const searchResult = (id: string, result: unknown, isError = false): Part => ({
  type: "tool-result",
  toolCallId: id,
  toolName: PROVIDER_WEB_SEARCH_TOOL,
  result: result as never,
  ...(isError ? { isError } : {}),
});

const urlSource = (
  url: string,
  providerMetadata?: Record<string, Record<string, unknown>>,
): Part => ({
  type: "source",
  sourceType: "url",
  id: url,
  url,
  title: `Title of ${url}`,
  ...(providerMetadata ? { providerMetadata: providerMetadata as never } : {}),
});

async function run(steps: Parameters<typeof makeModel>[0], maxSearches = 5) {
  const model = await makeModel(steps);
  const events: ProviderWebSearchEvent[] = [];
  const runTools = vi.fn(okRunTools);
  const result = await streamAiSdk(
    {
      ...base,
      tools: TOOLS,
      runTools,
      providerWebSearch: { maxSearches },
      callbacks: { onWebSearch: (event) => events.push(event) },
    },
    { ...config(model), webSearchTool: await anthropicSearch() },
  );
  return { model, events, result, runTools };
}

const toolNamesOf = (call: { tools?: Array<{ name: string }> }) =>
  (call.tools ?? []).map((tool) => tool.name);

describe("provider web search", () => {
  it("reports a search and its results without running a tool", async () => {
    const { events, result, runTools } = await run([
      step(
        searchCall("srvtoolu_1"),
        searchResult("srvtoolu_1", [
          { url: "https://gov.test/a", title: "A", encryptedContent: "x" },
          { title: "no url" },
        ]),
        ...text("The act says so."),
        finish("stop"),
      ),
    ]);

    expect(result.fullText).toBe("The act says so.");
    expect(events).toEqual([
      { kind: "search_started", id: "srvtoolu_1", query: "uk ai act" },
      {
        kind: "search_finished",
        id: "srvtoolu_1",
        query: "uk ai act",
        results: [{ url: "https://gov.test/a", title: "A" }],
        failed: false,
      },
    ]);
    expect(runTools).not.toHaveBeenCalled();
  });

  it("reports a failed provider search and carries on with the turn", async () => {
    const { events, result } = await run([
      step(
        searchCall("srvtoolu_1"),
        searchResult(
          "srvtoolu_1",
          { type: "web_search_tool_result_error", errorCode: "max_uses_exceeded" },
          true,
        ),
        ...text("Answered without it."),
        finish("stop"),
      ),
    ]);

    expect(result.fullText).toBe("Answered without it.");
    expect(events.at(-1)).toMatchObject({ kind: "search_finished", failed: true });
  });

  it("counts only sources without Anthropic's page age as cited", async () => {
    const { events } = await run([
      step(
        urlSource("https://gov.test/shown", { anthropic: { pageAge: null } }),
        urlSource("https://gov.test/cited", {
          anthropic: { citedText: "quote", encryptedIndex: "i" },
        }),
        ...text("Done."),
        finish("stop"),
      ),
    ]);

    expect(events).toEqual([
      {
        kind: "cited_source",
        source: { url: "https://gov.test/cited", title: "Title of https://gov.test/cited" },
      },
    ]);
  });

  it("keeps offering the tool after a step uses its searches", async () => {
    const { model } = await run(
      [
        step(
          searchCall("s1"),
          searchResult("s1", []),
          searchCall("s2"),
          searchResult("s2", []),
          toolCall("c1", "read_document", { doc_id: "doc-0" }),
          finish("tool-calls"),
        ),
        step(...text("done"), finish("stop")),
      ],
      2,
    );

    expect(toolNamesOf(model.doStreamCalls[0])).toEqual(["read_document", "web_search"]);
    expect(toolNamesOf(model.doStreamCalls[1])).toEqual(["read_document", "web_search"]);
  });
});

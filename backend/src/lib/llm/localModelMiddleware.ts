import type { LanguageModelMiddleware } from "ai" with {
  "resolution-mode": "import",
};
import {
  collapseTrademarkOwnerCalls,
  parseTextToolCalls,
  TextToolMarkupFilter,
  ThinkTagFilter,
} from "./toolCallParsing";
import type { NormalizedToolCall } from "./types";

// Adapts endpoints that cannot be trusted to emit structured tool calls onto
// the AI SDK's provider contract. The transport, retries and SSE parsing are
// the SDK's job; this middleware only rewrites what the model said:
//
//   * <think>…</think> prose becomes reasoning parts instead of visible text,
//   * tool markup in the text stream is suppressed rather than shown, and
//   * tool calls described in prose become real tool-call parts.
//
// Models that stream tool markup mid-sentence tend to also mis-handle
// streamed tool calls entirely, so a tolerant model answering a request that
// declares tools is served through doGenerate and replayed as a stream. That
// mirrors how these endpoints were driven before, without a bespoke client.

type StreamResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type FinishPart = Extract<StreamPart, { type: "finish" }>;
type FinishReason = GenerateResult["finishReason"];
type GenerateResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>
>;

/** Recovered calls change why the step ended; the provider's raw reason is
 * preserved for telemetry. */
function toolCallsFinishReason(original: FinishReason): FinishReason {
  return { unified: "tool-calls", raw: original.raw };
}

const TEXT_ID = "text-0";
const REASONING_ID = "reasoning-0";

function toToolCallParts(calls: NormalizedToolCall[]): StreamPart[] {
  return collapseTrademarkOwnerCalls(calls).map(
    (call) =>
      ({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: JSON.stringify(call.input),
      }) as StreamPart,
  );
}

/**
 * Parse tool calls out of assistant prose. Returns null when the text holds
 * no tool markup at all, which is the ordinary "the model just answered"
 * case; parse failures on text that *does* look like a tool call are
 * surfaced, because silently dropping one strands the request.
 */
function toolCallsFromText(text: string): NormalizedToolCall[] | null {
  try {
    const calls = parseTextToolCalls(text, 0);
    return calls.length ? calls : null;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function textFromContent(content: GenerateResult["content"]): {
  text: string;
  reasoning: string;
} {
  let text = "";
  let reasoning = "";
  for (const part of content) {
    if (part.type === "text") text += part.text;
    if (part.type === "reasoning") reasoning += part.text;
  }
  return { text, reasoning };
}

function replayAsStream(generated: GenerateResult): ReadableStream<StreamPart> {
  const { text, reasoning } = textFromContent(generated.content);
  const providerToolCalls = generated.content.filter(
    (part) => part.type === "tool-call",
  );

  return new ReadableStream<StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] } as StreamPart);

      const think = new ThinkTagFilter();
      const fed = think.feed(text);
      const flushed = think.flush();
      const reasoningText =
        reasoning + [...fed.reasoning, ...flushed.reasoning].join("");
      const visibleRaw = [...fed.content, ...flushed.content].join("");

      if (reasoningText) {
        controller.enqueue({
          type: "reasoning-start",
          id: REASONING_ID,
        } as StreamPart);
        controller.enqueue({
          type: "reasoning-delta",
          id: REASONING_ID,
          delta: reasoningText,
        } as StreamPart);
        controller.enqueue({
          type: "reasoning-end",
          id: REASONING_ID,
        } as StreamPart);
      }

      // Only mine the text for tool calls when the provider did not manage to
      // report any itself.
      let toolCalls: NormalizedToolCall[] | null = null;
      if (!providerToolCalls.length) {
        try {
          toolCalls = toolCallsFromText(visibleRaw);
        } catch (error) {
          controller.enqueue({ type: "error", error } as StreamPart);
          controller.close();
          return;
        }
      }

      const markup = new TextToolMarkupFilter();
      const visible = markup.feed(visibleRaw) + markup.flush();
      if (visible) {
        controller.enqueue({ type: "text-start", id: TEXT_ID } as StreamPart);
        controller.enqueue({
          type: "text-delta",
          id: TEXT_ID,
          delta: visible,
        } as StreamPart);
        controller.enqueue({ type: "text-end", id: TEXT_ID } as StreamPart);
      }

      for (const part of providerToolCalls) {
        controller.enqueue(part as StreamPart);
      }
      const recovered = toolCalls ? toToolCallParts(toolCalls) : [];
      for (const part of recovered) controller.enqueue(part);

      const finishReason: FinishReason =
        providerToolCalls.length || recovered.length
          ? toolCallsFinishReason(generated.finishReason)
          : generated.finishReason;
      controller.enqueue({
        type: "finish",
        usage: generated.usage,
        finishReason,
        providerMetadata: generated.providerMetadata,
      } as StreamPart);
      controller.close();
    },
  });
}

function tolerantTransform(): TransformStream<StreamPart, StreamPart> {
  const think = new ThinkTagFilter();
  const markup = new TextToolMarkupFilter();
  let rawText = "";
  let textId = TEXT_ID;
  let textStarted = false;
  let reasoningOpen = false;
  let sawProviderToolCall = false;
  let deferredFinish: FinishPart | null = null;

  function emitReasoning(
    controller: TransformStreamDefaultController<StreamPart>,
    chunks: string[],
  ) {
    for (const delta of chunks) {
      if (!delta) continue;
      if (!reasoningOpen) {
        reasoningOpen = true;
        controller.enqueue({
          type: "reasoning-start",
          id: REASONING_ID,
        } as StreamPart);
      }
      controller.enqueue({
        type: "reasoning-delta",
        id: REASONING_ID,
        delta,
      } as StreamPart);
    }
  }

  function emitVisible(
    controller: TransformStreamDefaultController<StreamPart>,
    text: string,
  ) {
    if (!text) return;
    if (!textStarted) {
      textStarted = true;
      controller.enqueue({ type: "text-start", id: textId } as StreamPart);
    }
    controller.enqueue({
      type: "text-delta",
      id: textId,
      delta: text,
    } as StreamPart);
  }

  return new TransformStream<StreamPart, StreamPart>({
    transform(part, controller) {
      switch (part.type) {
        case "text-start":
          // Held back until there is visible text to attribute to it — the
          // whole block may turn out to be tool markup.
          textId = part.id;
          return;
        case "text-end":
          return;
        case "text-delta": {
          rawText += part.delta;
          const { content, reasoning } = think.feed(part.delta);
          emitReasoning(controller, reasoning);
          emitVisible(controller, markup.feed(content.join("")));
          return;
        }
        case "tool-call":
          sawProviderToolCall = true;
          controller.enqueue(part);
          return;
        case "finish":
          deferredFinish = part as FinishPart;
          return;
        default:
          controller.enqueue(part);
      }
    },

    flush(controller) {
      const tail = think.flush();
      emitReasoning(controller, tail.reasoning);
      emitVisible(
        controller,
        markup.feed(tail.content.join("")) + markup.flush(),
      );
      if (reasoningOpen) {
        controller.enqueue({
          type: "reasoning-end",
          id: REASONING_ID,
        } as StreamPart);
      }
      if (textStarted) {
        controller.enqueue({ type: "text-end", id: textId } as StreamPart);
      }

      let recovered: StreamPart[] = [];
      if (!sawProviderToolCall && rawText) {
        try {
          const calls = toolCallsFromText(rawText);
          recovered = calls ? toToolCallParts(calls) : [];
        } catch (error) {
          controller.enqueue({ type: "error", error } as StreamPart);
          if (deferredFinish) controller.enqueue(deferredFinish);
          return;
        }
      }
      for (const part of recovered) controller.enqueue(part);

      if (deferredFinish) {
        controller.enqueue(
          recovered.length
            ? {
                ...deferredFinish,
                finishReason: toolCallsFinishReason(
                  deferredFinish.finishReason,
                ),
              }
            : deferredFinish,
        );
      }
    },
  });
}

/**
 * Wrap a model whose tool calls cannot be trusted to arrive structured.
 */
export function localModelToleranceMiddleware(): LanguageModelMiddleware {
  return {
    async wrapStream({ doStream, doGenerate, params }) {
      // Tool-using turns go through the non-streaming endpoint: these models
      // interleave tool markup with prose, which cannot be reassembled
      // reliably from a partial stream.
      if (params.tools?.length) {
        const generated = await doGenerate();
        return { stream: replayAsStream(generated) };
      }
      const { stream, ...rest } = await doStream();
      return { stream: stream.pipeThrough(tolerantTransform()), ...rest };
    },

    async wrapGenerate({ doGenerate }) {
      const generated = await doGenerate();
      const { text, reasoning } = textFromContent(generated.content);
      const hasProviderToolCall = generated.content.some(
        (part) => part.type === "tool-call",
      );

      const think = new ThinkTagFilter();
      const fed = think.feed(text);
      const flushed = think.flush();
      const reasoningText =
        reasoning + [...fed.reasoning, ...flushed.reasoning].join("");
      const visibleRaw = [...fed.content, ...flushed.content].join("");

      const calls = hasProviderToolCall ? null : toolCallsFromText(visibleRaw);
      const markup = new TextToolMarkupFilter();
      const visible = markup.feed(visibleRaw) + markup.flush();

      const content: GenerateResult["content"] = [];
      if (reasoningText) {
        content.push({
          type: "reasoning",
          text: reasoningText,
        } as GenerateResult["content"][number]);
      }
      if (visible) {
        content.push({
          type: "text",
          text: visible,
        } as GenerateResult["content"][number]);
      }
      for (const part of generated.content) {
        if (part.type === "tool-call") content.push(part);
      }
      const recovered = calls ? collapseTrademarkOwnerCalls(calls) : [];
      for (const call of recovered) {
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: JSON.stringify(call.input),
        } as GenerateResult["content"][number]);
      }

      const finishReason: FinishReason = recovered.length
        ? toolCallsFinishReason(generated.finishReason)
        : generated.finishReason;
      return { ...generated, content, finishReason };
    },
  };
}

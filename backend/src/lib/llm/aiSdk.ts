import type { LanguageModel, ToolSet } from "ai" with {
  "resolution-mode": "import",
};
import type * as AiSdk from "ai" with { "resolution-mode": "import" };
import type {
  LlmMessage,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  Provider,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { toProviderStreamError } from "./providerErrors";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const MAX_OUTPUT_TOKENS = 16_384;

/**
 * Tool-call rounds allowed per turn before `stopWhen` halts the run.
 *
 * 16, matching what the Word pane already passes. Document-heavy turns spend
 * several rounds just reading before any real work starts, and when this cap
 * fires the run simply ends — no error, no partial answer — so a value that is
 * merely "usually enough" fails invisibly. Callers may still override it.
 */
export const DEFAULT_MAX_ITERATIONS = 16;

/**
 * User-facing explanation for a turn that ended without finishing, or "" when
 * it ended normally.
 *
 * Exported for tests: the conditions are easy to get subtly wrong, and wrong
 * here means either a spurious warning under every good answer or silence
 * under every bad one.
 */
export function stopNotice(
  iterations: number,
  maxIterations: number,
  finishReason: string | undefined,
): string {
  if (finishReason === "length") {
    return "\n\n_Stopped early: this response reached the model's output limit. Asking for one part at a time will get the rest._";
  }
  // Reaching the last round while still asking for tools means the model was
  // mid-work when stopWhen cut it off. Reaching it on "stop" means it had
  // finished and the round count is a coincidence, so say nothing.
  if (iterations >= maxIterations && finishReason !== "stop") {
    return `\n\n_Stopped after ${maxIterations} tool-call rounds without finishing. This is a step limit, not a length limit — narrowing the request, or pointing at fewer documents, usually resolves it._`;
  }
  return "";
}

/** Ensure a proxy-closed final SSE event is still visible to SDK parsers. */
export async function aiSdkFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    return response;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const partials = new Map<number, { name: string; arguments: string }>();

  const validateToolCalls = (endedCleanly: boolean) => {
    for (const partial of partials.values()) {
      if (!partial.arguments) {
        if (!endedCleanly) {
          throw new Error(
            `LLM stream ended before any arguments arrived for tool "${partial.name}".`,
          );
        }
        continue;
      }
      try {
        JSON.parse(partial.arguments);
      } catch {
        // A clean terminal event proves that the transport delivered the
        // complete provider response. Preserve malformed arguments exactly as
        // sent so AI SDK can emit its recoverable dynamic tool-error instead
        // of preempting its tool-validation path. A stream that just closes is
        // still unsafe: its partial arguments must fail before any tool could
        // run.
        if (!endedCleanly) {
          throw new Error(
            `LLM stream ended with malformed JSON arguments for tool "${partial.name}".`,
          );
        }
      }
      if (!endedCleanly) {
        throw new Error(
          `LLM stream ended before a clean terminal event for tool "${partial.name}".`,
        );
      }
    }
    partials.clear();
  };

  const inspectLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      validateToolCalls(true);
      return;
    }
    if (!data) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const choice = (
      event.choices as
        | Array<{
            delta?: { tool_calls?: Array<Record<string, unknown>> };
            finish_reason?: unknown;
          }>
        | undefined
    )?.[0];
    for (const toolCall of choice?.delta?.tool_calls ?? []) {
      const index = typeof toolCall.index === "number" ? toolCall.index : 0;
      const current = partials.get(index) ?? { name: "tool", arguments: "" };
      const fn = toolCall.function as Record<string, unknown> | undefined;
      if (typeof fn?.name === "string") current.name = fn.name;
      if (typeof fn?.arguments === "string") {
        current.arguments += fn.arguments;
      }
      partials.set(index, current);
    }
    if (choice?.finish_reason === "tool_calls") validateToolCalls(true);
  };

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          inspectLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) inspectLine(buffer);
        if (partials.size) validateToolCalls(false);
        controller.enqueue(new Uint8Array([10, 10]));
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const COURTLISTENER_CITATION_REMINDER_TOOL_NAMES = new Set([
  "courtlistener_find_in_case",
  "courtlistener_read_case",
]);

const COURTLISTENER_CITATION_REMINDER = `COURTLISTENER CITATION REMINDER:
If your final answer relies on any CourtListener case, every such case reference must have BOTH a clickable markdown case link and an inline [N] marker.
Include the clickable case link only the first time you cite that case; later references to the same case should reuse the existing inline [N] marker without repeating the link unless clarity requires it.
Assign new refs in first-use order as much as possible: [1], then [2], then [3]. Reuse an existing ref when citing the same case/passage again, even if that means a later sentence cites [3] and then [1] again.
End the response with a <CITATIONS> block containing one matching case entry per [N] marker:
{"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact verbatim opinion text"}]}.
Do not use doc_id, page, top-level quote, case_name, or citation fields for CourtListener case entries.`;

export type AiSdkAdapterConfig = {
  provider: Provider;
  label: string;
  model: LanguageModel;
  modelId: string;
  /** Some protocol-compatible gateways reject reasoning request fields. */
  supportsReasoning?: boolean;
  /** OpenAI's CourtListener tools require an extra instruction after use. */
  courtlistenerCitationReminder?: boolean;
  /** Send stored reasoning on earlier assistant turns; see ConfiguredModel. */
  replayReasoning?: boolean;
};

type PendingToolExecution = {
  call: NormalizedToolCall;
  resolve: (content: string) => void;
  reject: (error: unknown) => void;
};

/**
 * AI SDK executes all tool calls from a step concurrently. Collect those
 * same-tick executions so the existing provider-neutral runTools contract
 * still receives one batch per model step.
 */
class ToolExecutionBatcher {
  private pending: PendingToolExecution[] = [];
  private scheduled = false;

  constructor(
    private readonly runTools: NonNullable<StreamChatParams["runTools"]>,
    /** Fired synchronously when runTools rejects, before the SDK learns of it. */
    private readonly onFailure?: (error: unknown) => void,
  ) {}

  execute(call: NormalizedToolCall): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending.push({ call, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    this.scheduled = false;

    try {
      const results = await this.runTools(pending.map(({ call }) => call));
      const byId = new Map(
        results.map((result: NormalizedToolResult) => [
          result.tool_use_id,
          result.content,
        ]),
      );
      for (const item of pending) {
        const content = byId.get(item.call.id);
        if (content === undefined) {
          const error = new Error(
            `Tool ${item.call.name} returned no result for call ${item.call.id}.`,
          );
          this.onFailure?.(error);
          item.reject(error);
        } else {
          item.resolve(content);
        }
      }
    } catch (error) {
      this.onFailure?.(error);
      for (const item of pending) item.reject(error);
    }
  }
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function toAiSdkTools(
  schemas: OpenAIToolSchema[],
  runTools?: StreamChatParams["runTools"],
  sdk?: Pick<typeof AiSdk, "jsonSchema" | "tool">,
  onRunToolsFailure?: (error: unknown) => void,
): ToolSet | undefined {
  if (!schemas.length) return undefined;
  if (!sdk) throw new Error("AI SDK tool helpers are unavailable.");
  const batcher = runTools
    ? new ToolExecutionBatcher(runTools, onRunToolsFailure)
    : null;

  return Object.fromEntries(
    schemas.map((schema) => {
      const definition = {
        description: schema.function.description,
        inputSchema: sdk.jsonSchema<Record<string, unknown>>(
          schema.function.parameters as never,
        ),
        ...(batcher
          ? {
              execute: (
                input: Record<string, unknown>,
                { toolCallId }: { toolCallId: string },
              ) =>
                batcher.execute({
                  id: toolCallId,
                  name: schema.function.name,
                  input: normalizeToolInput(input),
                }),
            }
          : {}),
      };
      return [schema.function.name, sdk.tool(definition as never)];
    }),
  );
}

function errorMessage(error: unknown, label: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return `${label} stream failed.`;
}

/**
 * The ORIGINAL Error instance from a `tool-error` / `error` part. Re-wrapping
 * it discards error identity, including control-flow and user-facing error
 * types thrown inside runTools (the SDK's tool `execute`).
 */
function rethrowable(error: unknown, label: string): Error {
  return error instanceof Error ? error : new Error(errorMessage(error, label));
}

function usesCourtlistenerTool(
  steps: Array<{ toolCalls: Array<{ toolName: string }> }>,
) {
  return steps.some((step) =>
    step.toolCalls.some((call) =>
      COURTLISTENER_CITATION_REMINDER_TOOL_NAMES.has(call.toolName),
    ),
  );
}

/**
 * Provider-specific hints that let a multi-turn conversation reuse the
 * already-processed prompt prefix instead of paying for it on every turn.
 *
 * OpenAI caches automatically but routes by `prompt_cache_key`; sending the
 * conversation id keeps consecutive turns on the same cache. Anthropic only
 * caches up to an explicit breakpoint, so the last message gets one: it
 * covers the system prompt, tool definitions, and every earlier turn, and
 * the next request hits that prefix as long as it is byte-identical.
 * Providers ignore namespaces they do not own, so both hints are sent.
 */
type StreamTextProviderOptions = NonNullable<
  Parameters<typeof AiSdk.streamText>[0]["providerOptions"]
>;

/**
 * An earlier assistant turn's reasoning becomes a reasoning part ahead of its
 * text, which the OpenAI-compatible adapter sends as `reasoning_content`.
 * Without `replay` the stored reasoning is dropped, so no other provider ever
 * receives it.
 */
function toModelMessage(
  message: LlmMessage,
  replay: boolean,
): AiSdk.UserModelMessage | AiSdk.AssistantModelMessage {
  if (message.role === "user") {
    return { role: "user", content: message.content };
  }
  if (!replay || !message.reasoning) {
    return { role: "assistant", content: message.content };
  }
  return {
    role: "assistant",
    content: [
      { type: "reasoning", text: message.reasoning },
      { type: "text", text: message.content },
    ],
  };
}

export function withPrefixCacheHints(
  params: StreamChatParams,
  options: { replayReasoning?: boolean } = {},
): {
  messages: AiSdk.ModelMessage[];
  providerOptions?: StreamTextProviderOptions;
} {
  const messages: (AiSdk.UserModelMessage | AiSdk.AssistantModelMessage)[] =
    params.messages.some((m) => m.reasoning !== undefined)
      ? params.messages.map((m) =>
          toModelMessage(m, options.replayReasoning === true),
        )
      : params.messages;
  if (!params.conversationId || !messages.length) {
    return { messages };
  }
  const last = messages.length - 1;
  const breakpoint = {
    anthropic: { cacheControl: { type: "ephemeral" } },
  };
  return {
    messages: messages.map((message, index): AiSdk.ModelMessage => {
      if (index !== last) return message;
      return message.role === "assistant"
        ? { role: "assistant", content: message.content, providerOptions: breakpoint }
        : { role: "user", content: message.content, providerOptions: breakpoint };
    }),
    providerOptions: {
      openai: { promptCacheKey: params.conversationId },
    },
  };
}

export async function streamAiSdk(
  params: StreamChatParams,
  config: AiSdkAdapterConfig,
): Promise<StreamChatResult> {
  const sdk = await import("ai");
  // Internal abort linked to the caller's signal: a runTools failure (e.g. the
  // ask_inputs pause) ends the turn, but the SDK's step loop would fire the
  // NEXT model request before this consumer sees the `tool-error` part — so
  // abort synchronously in the batcher's failure path and keep that first
  // failure (the stream may surface an `abort` part before the `tool-error`).
  const internalAbort = new AbortController();
  const forwardAbort = () => internalAbort.abort(params.abortSignal?.reason);
  if (params.abortSignal?.aborted) forwardAbort();
  else params.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  const runToolsFailure: { first: { error: unknown } | null } = { first: null };
  const tools = toAiSdkTools(params.tools ?? [], params.runTools, sdk, (error) => {
    runToolsFailure.first ??= { error };
    internalAbort.abort();
  });
  // An exception that merely LOOKS like an abort (name "AbortError" or
  // isAbortError's exact message) must not take streaming.ts's silent
  // user-cancel path unless the caller's signal really is aborted.
  const guardAbortShaped = (e: Error): Error =>
    params.abortSignal?.aborted ||
    (e.name !== "AbortError" && e.message !== "Stream aborted.")
      ? e
      : new Error(
          e.message === "Stream aborted."
            ? "Stream aborted. (no abort was requested; treated as an error)"
            : e.message,
          { cause: e },
        );
  const cacheHints = withPrefixCacheHints(params, {
    replayReasoning: config.replayReasoning,
  });
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: config.provider,
    model: config.modelId,
  });
  let fullText = "";
  let iteration = 0;
  const openReasoningBlocks = new Set<string>();
  const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let lastFinishReason: string | undefined;

  try {
    const result = sdk.streamText({
      model: config.model,
      system: params.systemPrompt,
      messages: cacheHints.messages,
      ...(cacheHints.providerOptions
        ? { providerOptions: cacheHints.providerOptions }
        : {}),
      tools,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      stopWhen: sdk.stepCountIs(maxIterations),
      abortSignal: internalAbort.signal,
      reasoning:
        config.supportsReasoning === false
          ? undefined
          : // The OpenAI adapter and API support `max`, while AI SDK Core 7's
            // shared call-options type still omits it. Preserve the runtime
            // value across that temporary upstream type mismatch.
            ((params.reasoning ?? "none") as
              | "provider-default"
              | Exclude<NonNullable<StreamChatParams["reasoning"]>, "max">
              | undefined),
      include: { rawChunks: true },
      // Without an onError, streamText's default is `console.error(error)`:
      // the raw provider error is logged — and filed by the Sentry console
      // bridge — before the same failure reaches the "error" part below,
      // where it is classified and the caller reports it once
      // (MIKE-BACKEND-C). Every failure still arrives through fullStream.
      onError: () => {},
      ...(config.courtlistenerCitationReminder
        ? {
            prepareStep: ({
              steps,
            }: {
              steps: Array<{ toolCalls: Array<{ toolName: string }> }>;
            }) =>
              usesCourtlistenerTool(steps)
                ? {
                    system: `${params.systemPrompt}\n\n${COURTLISTENER_CITATION_REMINDER}`,
                  }
                : undefined,
          }
        : {}),
    });

    for await (const part of result.stream) {
      switch (part.type) {
        case "start-step":
          iteration += 1;
          break;
        case "raw":
          logRawLlmStream({
            provider: config.provider,
            model: config.modelId,
            iteration: Math.max(0, iteration - 1),
            label: "ai_sdk_raw",
            payload: part.rawValue,
          });
          rawStreamRecorder?.record({
            iteration: Math.max(0, iteration - 1),
            label: "ai_sdk_raw",
            payload: part.rawValue,
          });
          break;
        case "text-delta":
          fullText += part.text;
          params.callbacks?.onContentDelta?.(part.text);
          break;
        case "reasoning-start":
          openReasoningBlocks.add(part.id);
          break;
        case "reasoning-delta":
          openReasoningBlocks.add(part.id);
          params.callbacks?.onReasoningDelta?.(part.text);
          break;
        case "reasoning-end":
          if (openReasoningBlocks.delete(part.id)) {
            params.callbacks?.onReasoningBlockEnd?.();
          }
          break;
        case "tool-call": {
          const call: NormalizedToolCall = {
            id: part.toolCallId,
            name: part.toolName,
            input: normalizeToolInput(part.input),
          };
          params.callbacks?.onToolCallStart?.(call);
          break;
        }
        case "finish-step":
          lastFinishReason = part.finishReason;
          break;
        // A tool's own failure is not the model provider's: a search tool
        // answering 401 says nothing about our LLM key, so this path keeps the
        // executor error rather than blaming the user's credentials.
        case "tool-error":
          // `dynamic: true` = the SDK synthesized this part for a call it could
          // not dispatch (unknown tool / unparseable input); it already queued
          // the error as that call's result and continues the loop so the
          // model can recover. Mike's tools are static, so only a genuine
          // execute() failure reaches the throw.
          if ((part as { dynamic?: boolean }).dynamic === true) break;
          runToolsFailure.first ??= { error: part.error };
          throw guardAbortShaped(rethrowable(part.error, config.label));
        case "error":
          throw guardAbortShaped(toProviderStreamError(part.error, config));
        case "abort": {
          const error = new Error(part.reason || "Stream aborted.");
          error.name = "AbortError";
          throw error;
        }
      }
    }

    for (const id of openReasoningBlocks) {
      openReasoningBlocks.delete(id);
      params.callbacks?.onReasoningBlockEnd?.();
    }
    // A run halted by stopWhen, or cut off at the output ceiling, otherwise
    // ends exactly like a finished one: streamText just stops and this
    // function returns whatever text happened to accumulate. That renders as
    // a bare "Completed in N steps" with no answer and no error, which is
    // indistinguishable from the model having nothing to say. Name it instead.
    const notice = stopNotice(iteration, maxIterations, lastFinishReason);
    if (notice) {
      fullText += notice;
      params.callbacks?.onContentDelta?.(notice);
    }
    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    internalAbort.abort();
    // Only model-provider failures are eligible for API-key/quota guidance.
    // Tool failures (including pauses) retain their original identity.
    const fatal = runToolsFailure.first
      ? guardAbortShaped(rethrowable(runToolsFailure.first.error, config.label))
      : guardAbortShaped(toProviderStreamError(error, config));
    await rawStreamRecorder?.flush("error", fatal);
    throw fatal;
  } finally {
    params.abortSignal?.removeEventListener("abort", forwardAbort);
  }
}

export async function completeAiSdkText(
  params: {
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
  },
  config: AiSdkAdapterConfig,
): Promise<string> {
  const { generateText } = await import("ai");
  const result = await generateText({
    model: config.model,
    system: params.systemPrompt,
    prompt: params.user,
    maxOutputTokens: params.maxTokens ?? 512,
    reasoning: config.supportsReasoning === false ? undefined : "none",
  });
  return result.text;
}

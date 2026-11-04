import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as AgentSdk from "@anthropic-ai/claude-agent-sdk" with {
  "resolution-mode": "import",
};
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  claudeCodeIdleTimeoutMs,
  claudeCodeTimeoutMs,
} from "../runtimeConfig";
import { ToolExecutionBatcher } from "./aiSdk";
import { claudeCodeModelAlias, isClaudeCodeEnabled } from "./models";
import type {
  LlmMessage,
  NormalizedToolCall,
  OpenAIToolSchema,
  ReasoningLevel,
  StreamChatParams,
  StreamChatResult,
} from "./types";

// Local Claude Code (Agent SDK) provider. Each call spawns the bundled
// `claude` binary, authenticated by the operator's Claude subscription
// (CLAUDE_CODE_OAUTH_TOKEN or an existing `claude` login). Mike's own tools
// are exposed to Claude Code through an in-process MCP server whose handlers
// feed the provider-neutral runTools contract, so tool execution, SSE events
// and Word round-trips behave exactly as with the API providers.

const MCP_SERVER_NAME = "mike";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

// Only these variables reach the Claude Code subprocess. Mike's own secrets
// (database, storage, provider API keys) stay out of it, and an inherited
// ANTHROPIC_API_KEY would otherwise take precedence over the subscription.
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
];

type AgentSdkModule = Pick<typeof AgentSdk, "query" | "createSdkMcpServer">;
type SdkMessage = AgentSdk.SDKMessage;

function assertEnabled(): void {
  if (!isClaudeCodeEnabled()) {
    throw new Error(
      "Claude Code models are disabled. Set CLAUDE_CODE_ENABLED=true on the backend.",
    );
  }
}

async function loadSdk(): Promise<AgentSdkModule> {
  return import("@anthropic-ai/claude-agent-sdk");
}

function subprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    CLAUDE_AGENT_SDK_CLIENT_APP: "mike-backend",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  for (const name of PASSTHROUGH_ENV) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

let scratchDir: string | undefined;
/** An empty working directory so no project files or CLAUDE.md are visible. */
function workingDirectory(): string {
  scratchDir ??= mkdtempSync(join(tmpdir(), "mike-claude-code-"));
  return scratchDir;
}

function thinkingOptions(
  reasoning: ReasoningLevel | undefined,
): Pick<AgentSdk.Options, "thinking" | "effort"> {
  if (!reasoning || reasoning === "none") {
    return { thinking: { type: "disabled" } };
  }
  return { thinking: { type: "adaptive" }, effort: reasoning };
}

function baseOptions(model: string, systemPrompt: string | undefined) {
  return {
    model: claudeCodeModelAlias(model),
    systemPrompt: systemPrompt ?? "",
    cwd: workingDirectory(),
    env: subprocessEnv(),
    pathToClaudeCodeExecutable:
      process.env.CLAUDE_CODE_PATH?.trim() || undefined,
    // No built-in tools, no host settings, hooks, plugins or MCP config.
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
  } satisfies AgentSdk.Options;
}

/**
 * Mike's history is text-only, and Claude Code accepts one prompt per query.
 * Earlier turns are replayed as a delimited transcript ahead of the latest
 * user message.
 */
export function serializeClaudeCodePrompt(messages: LlmMessage[]): string {
  const turns = messages.filter((m) => m.content.trim());
  if (!turns.length) return "";
  const last = turns[turns.length - 1];
  if (turns.length === 1 && last.role === "user") return last.content;

  const history = (last.role === "user" ? turns.slice(0, -1) : turns)
    .map((m) => `<turn role="${m.role}">\n${m.content}\n</turn>`)
    .join("\n\n");
  const latest = last.role === "user" ? last.content : "Continue.";
  return `<conversation_history>\n${history}\n</conversation_history>\n\n${latest}`;
}

function stripToolPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX)
    ? name.slice(MCP_TOOL_PREFIX.length)
    : name;
}

function normalizeInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Tool-call ids announced by assistant messages, consumed in order by the MCP
 * handlers so runTools sees the model's own tool_use ids.
 */
class ToolUseIdQueue {
  private byName = new Map<string, string[]>();
  private counter = 0;

  push(name: string, id: string): void {
    const queue = this.byName.get(name) ?? [];
    queue.push(id);
    this.byName.set(name, queue);
  }

  take(name: string, preferred?: string): string {
    const queue = this.byName.get(name) ?? [];
    if (preferred) {
      const index = queue.indexOf(preferred);
      if (index >= 0) queue.splice(index, 1);
      return preferred;
    }
    return queue.shift() ?? `claude_code_call_${++this.counter}`;
  }
}

function createMikeMcpServer(args: {
  sdk: AgentSdkModule;
  tools: OpenAIToolSchema[];
  execute: (call: NormalizedToolCall) => Promise<string>;
  ids: ToolUseIdQueue;
}): AgentSdk.McpSdkServerConfigWithInstance {
  // Use the SDK's own McpServer copy (ESM) so its in-process transport
  // accepts the instance; tools are registered below at the protocol level.
  const config = args.sdk.createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [],
  });
  const server = config.instance;
  server.server.registerCapabilities({ tools: {} });
  const known = new Set(args.tools.map((t) => t.function.name));

  // Low-level handlers pass Mike's JSON Schemas through verbatim instead of
  // round-tripping them through zod.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: args.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: {
        type: "object" as const,
        ...t.function.parameters,
      },
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!known.has(name)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool '${name}' is not available.` }],
      };
    }
    const meta = request.params._meta as Record<string, unknown> | undefined;
    const metaId = meta?.["claudecode/toolUseId"];
    const id = args.ids.take(
      name,
      typeof metaId === "string" ? metaId : undefined,
    );
    const text = await args.execute({
      id,
      name,
      input: normalizeInput(request.params.arguments),
    });
    return { content: [{ type: "text", text }] };
  });

  return config;
}

function resultError(message: SdkMessage): Error | null {
  if (message.type !== "result") return null;
  if (message.subtype === "success" && !message.is_error) return null;
  const detail =
    "errors" in message && Array.isArray(message.errors) && message.errors.length
      ? message.errors.join("; ")
      : "result" in message && typeof message.result === "string"
        ? message.result
        : message.subtype;
  return new Error(`Claude Code request failed: ${detail}`);
}

/**
 * Aborts a turn that has gone quiet. Every SDK message restarts the
 * countdown, so only genuine silence from the subprocess trips it. Mike's own
 * tool runs are paused out: while a tool is in flight Claude Code is waiting
 * on us, which is not a stall on its side.
 */
class IdleWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = 0;
  private stopped = false;

  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {}

  touch(): void {
    this.clear();
    if (this.stopped || !this.ms || this.inFlight) return;
    this.timer = setTimeout(this.onIdle, this.ms).unref();
  }

  pause(): void {
    this.inFlight += 1;
    this.clear();
  }

  resume(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (!this.inFlight) this.touch();
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function idleError(ms: number): Error {
  return new Error(
    `Claude Code stopped responding after ${Math.round(ms / 1000)}s without output.`,
  );
}

function deadlineError(ms: number): Error {
  return new Error(
    `Claude Code did not finish within ${Math.round(ms / 60_000)} minutes.`,
  );
}

/**
 * The total budget for a turn. Unlike the idle watchdog this never pauses:
 * a turn that keeps emitting output or tool calls but never converges is
 * exactly what it exists to stop.
 */
function startDeadline(
  ms: number,
  onExpiry: () => void,
): NodeJS.Timeout | undefined {
  return ms ? setTimeout(onExpiry, ms).unref() : undefined;
}

function linkAbort(signal: AbortSignal | undefined): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", () => controller.abort(signal.reason), {
    once: true,
  });
  return controller;
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : "Stream aborted.",
  );
  error.name = "AbortError";
  return error;
}

export async function streamClaudeCode(
  params: StreamChatParams,
  sdk?: AgentSdkModule,
): Promise<StreamChatResult> {
  assertEnabled();
  const loaded = sdk ?? (await loadSdk());
  const abortController = linkAbort(params.abortSignal);
  const tools = params.runTools ? (params.tools ?? []) : [];
  const ids = new ToolUseIdQueue();

  const idleMs = claudeCodeIdleTimeoutMs();
  const timeoutMs = claudeCodeTimeoutMs();
  let idleTimedOut = false;
  let deadlineExpired = false;
  const watchdog = new IdleWatchdog(idleMs, () => {
    idleTimedOut = true;
    abortController.abort();
  });
  const deadline = startDeadline(timeoutMs, () => {
    deadlineExpired = true;
    abortController.abort();
  });

  // A runTools failure (ask_inputs pause, abort, dispatcher error) ends the
  // whole query and is rethrown unchanged to the chat loop.
  let toolFailure: unknown;
  const batcher = params.runTools
    ? new ToolExecutionBatcher(params.runTools)
    : null;
  const execute = async (call: NormalizedToolCall) => {
    watchdog.pause();
    try {
      return await batcher!.execute(call);
    } catch (error) {
      toolFailure ??= error;
      abortController.abort(error);
      throw error;
    } finally {
      watchdog.resume();
    }
  };

  let fullText = "";
  let thinkingOpen = false;
  const q = loaded.query({
    prompt: serializeClaudeCodePrompt(params.messages),
    options: {
      ...baseOptions(params.model, params.systemPrompt),
      ...thinkingOptions(params.reasoning),
      abortController,
      includePartialMessages: true,
      maxTurns: params.maxIterations ?? 10,
      ...(tools.length
        ? {
            mcpServers: {
              [MCP_SERVER_NAME]: createMikeMcpServer({
                sdk: loaded,
                tools,
                execute,
                ids,
              }),
            },
            allowedTools: tools.map((t) => MCP_TOOL_PREFIX + t.function.name),
            permissionMode: "dontAsk" as const,
          }
        : {}),
    },
  });

  const closeThinking = () => {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    params.callbacks?.onReasoningBlockEnd?.();
  };

  watchdog.touch();
  try {
    for await (const message of q) {
      watchdog.touch();
      if ("parent_tool_use_id" in message && message.parent_tool_use_id) {
        continue;
      }
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_start") {
          if (event.content_block.type === "thinking") thinkingOpen = true;
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            fullText += event.delta.text;
            params.callbacks?.onContentDelta?.(event.delta.text);
          } else if (event.delta.type === "thinking_delta") {
            thinkingOpen = true;
            params.callbacks?.onReasoningDelta?.(event.delta.thinking);
          }
        } else if (event.type === "content_block_stop") {
          closeThinking();
        }
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type !== "tool_use") continue;
          const name = stripToolPrefix(block.name);
          ids.push(name, block.id);
          params.callbacks?.onToolCallStart?.({
            id: block.id,
            name,
            input: normalizeInput(block.input),
          });
        }
      } else if (message.type === "result") {
        closeThinking();
        const error = resultError(message);
        // Hitting maxTurns mirrors the AI SDK's stepCountIs stop: keep the
        // text produced so far rather than failing the turn.
        if (error && message.subtype !== "error_max_turns") throw error;
      }
    }
  } catch (error) {
    if (toolFailure !== undefined) throw toolFailure;
    if (params.abortSignal?.aborted) throw abortError(params.abortSignal);
    if (deadlineExpired) throw deadlineError(timeoutMs);
    if (idleTimedOut) throw idleError(idleMs);
    throw error;
  } finally {
    watchdog.stop();
    if (deadline) clearTimeout(deadline);
    closeThinking();
    q.close();
  }

  if (toolFailure !== undefined) throw toolFailure;
  if (params.abortSignal?.aborted) throw abortError(params.abortSignal);
  if (deadlineExpired) throw deadlineError(timeoutMs);
  if (idleTimedOut) throw idleError(idleMs);
  return { fullText };
}

export async function completeClaudeCode(
  params: { model: string; systemPrompt?: string; user: string },
  sdk?: AgentSdkModule,
): Promise<string> {
  assertEnabled();
  const { query } = sdk ?? (await loadSdk());
  // Title generation is awaited before the chat stream closes, so it gets the
  // same time bounds as a streamed turn. It runs no tools, so no pausing.
  const idleMs = claudeCodeIdleTimeoutMs();
  const timeoutMs = claudeCodeTimeoutMs();
  let idleTimedOut = false;
  let deadlineExpired = false;
  const abortController = new AbortController();
  const watchdog = new IdleWatchdog(idleMs, () => {
    idleTimedOut = true;
    abortController.abort();
  });
  const deadline = startDeadline(timeoutMs, () => {
    deadlineExpired = true;
    abortController.abort();
  });
  const q = query({
    prompt: params.user,
    options: {
      ...baseOptions(params.model, params.systemPrompt),
      abortController,
      thinking: { type: "disabled" },
      maxTurns: 1,
    },
  });
  watchdog.touch();
  try {
    for await (const message of q) {
      watchdog.touch();
      if (message.type !== "result") continue;
      // A result can be queued as a timer fires. Returning it here would skip
      // the checks after the loop, so a turn we abandoned would look like it
      // succeeded; checking before resultError also keeps the message about
      // the bound rather than the abort it caused.
      if (deadlineExpired) throw deadlineError(timeoutMs);
      if (idleTimedOut) throw idleError(idleMs);
      const error = resultError(message);
      if (error) throw error;
      return message.subtype === "success" ? message.result : "";
    }
  } catch (error) {
    if (deadlineExpired) throw deadlineError(timeoutMs);
    if (idleTimedOut) throw idleError(idleMs);
    throw error;
  } finally {
    watchdog.stop();
    if (deadline) clearTimeout(deadline);
    q.close();
  }
  if (deadlineExpired) throw deadlineError(timeoutMs);
  if (idleTimedOut) throw idleError(idleMs);
  throw new Error("Claude Code returned no result.");
}

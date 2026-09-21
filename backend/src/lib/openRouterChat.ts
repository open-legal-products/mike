// Minimal OpenAI-compatible chat-completions client for OpenRouter, used by
// the contract-review prompts (non-streaming, optional forced tool call).
// Mike's streaming assistant goes through lib/llm; this stays deliberately
// tiny so the review pipeline has no dependency on the AI SDK adapters.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ChatTool[];
  tool_choice?: { type: "function"; function: { name: string } };
}

export interface ChatResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON body when ok; raw error text otherwise. */
  json: unknown;
  errorText: string | null;
}

export type ChatFn = (req: ChatRequest) => Promise<ChatResponse>;

export class AiGatewayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AiGatewayError";
  }
}

const BASE_URL = (process.env.OPENROUTER_BASE_URL?.trim().replace(/\/+$/, "") || "https://openrouter.ai/api/v1");
const DEFAULT_TIMEOUT_MS = 180_000;

export function openRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

/** One chat completion. Never throws on HTTP errors; throws on network/timeout. */
export async function openRouterChat(req: ChatRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ChatResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new AiGatewayError(503, "OPENROUTER_API_KEY is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter attribution headers (optional, shown in their dashboard).
        "HTTP-Referer": process.env.API_PUBLIC_URL?.trim() || "https://mike.local",
        "X-Title": "Tinjau contract review",
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return { ok: false, status: response.status, json: null, errorText };
    }
    return { ok: true, status: response.status, json: await response.json(), errorText: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull `choices[0].message` out of an OpenAI-style response. */
export function firstMessage(json: unknown): { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } | null {
  const choices = (json as { choices?: Array<{ message?: unknown }> } | null)?.choices;
  const message = choices?.[0]?.message;
  return message && typeof message === "object" ? (message as ReturnType<typeof firstMessage>) : null;
}

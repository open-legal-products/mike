/**
 * Minimal client for the janus-tools MCP server (fixed endpoint + static bearer).
 * We deliberately do NOT use the per-user connector stack in lib/mcp/* — this is
 * a single fixed server reached over a plain JSON-RPC 2.0 tools/call.
 */

const JANUS_TOOLS_URL = process.env.JANUS_TOOLS_URL;
const JANUS_TOOLS_TOKEN = process.env.JANUS_TOOLS_TOKEN;

export function janusToolsConfigured(): boolean {
  return Boolean(JANUS_TOOLS_URL && JANUS_TOOLS_TOKEN);
}

/**
 * Call a janus-tools tool and return its text output. Throws on transport error,
 * JSON-RPC error, or a tool-level error (isError). Default 90s timeout since the
 * AI review can take ~30-60s.
 */
export async function callJanusTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 90_000,
): Promise<string> {
  if (!JANUS_TOOLS_URL || !JANUS_TOOLS_TOKEN) {
    throw new Error("JANUS_TOOLS_URL / JANUS_TOOLS_TOKEN are not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(JANUS_TOOLS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${JANUS_TOOLS_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`janus-tools HTTP ${res.status}: ${raw.slice(0, 300)}`);
    }

    // Streamable-HTTP servers may reply with an SSE frame instead of plain JSON.
    // A single SSE event's data can span multiple consecutive `data:` lines that
    // must be concatenated with newlines (SSE spec) — don't take just the first.
    let jsonText = raw.trim();
    if (jsonText.startsWith("event:") || jsonText.startsWith("data:")) {
      const dataLines = jsonText
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).replace(/^ /, ""));
      jsonText = dataLines.length ? dataLines.join("\n").trim() : jsonText;
    }

    const msg = JSON.parse(jsonText) as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: { type: string; text?: string }[] };
    };
    if (msg.error) {
      throw new Error(`janus-tools error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    }
    const result = msg.result;
    const text = result?.content?.[0]?.text;
    if (result?.isError) {
      throw new Error(`janus-tools tool "${name}" failed: ${text ?? "unknown error"}`);
    }
    if (typeof text !== "string") {
      throw new Error(`janus-tools tool "${name}" returned no text content`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

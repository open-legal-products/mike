// jsonrepair declares "type": "module" but ships a CommonJS build; importing
// it normally trips TS1479 under this package's Node16 CJS resolution.
const { jsonrepair } = require("jsonrepair") as {
  jsonrepair: (text: string) => string;
};

import type { NormalizedToolCall } from "./types";

// Tolerance for models that describe tool calls in prose instead of emitting
// them as structured tool-call fields. Self-hosted builds of Qwen, DeepSeek,
// GLM and friends routinely do this, in a different dialect each: a JSON
// object inside <tool_call> markers, an XML-ish <function=name> block, a
// DeepSeek DSML invoke, or a bare map whose single key is the tool name.
// Hosted providers never need any of it, so this module is only wired up for
// endpoints the registry marks as tolerant (see localModelMiddleware.ts).
//
// Everything here is pure text handling: no transport, no provider SDK.

const THINK_OPEN = "<think>";

const THINK_CLOSE = "</think>";

// Routes inline <think>...</think> blocks (qwen/deepseek style) to the
// reasoning channel instead of the visible content stream. Tags can be
// split across SSE chunks, so partial-tag suffixes are buffered.
export class ThinkTagFilter {
  private insideThink = false;
  private buffer = "";
  sawReasoning = false;

  feed(text: string): { content: string[]; reasoning: string[] } {
    this.buffer += text;
    const content: string[] = [];
    const reasoning: string[] = [];

    while (this.buffer.length) {
      const tag = this.insideThink ? THINK_CLOSE : THINK_OPEN;
      const idx = this.buffer.indexOf(tag);
      if (idx === -1) {
        const hold = this.partialTagSuffixLength(tag);
        const emit = this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        if (emit) this.emit(emit, content, reasoning);
        break;
      }
      const before = this.buffer.slice(0, idx);
      if (before) this.emit(before, content, reasoning);
      this.buffer = this.buffer.slice(idx + tag.length);
      this.insideThink = !this.insideThink;
    }

    return { content, reasoning };
  }

  flush(): { content: string[]; reasoning: string[] } {
    const content: string[] = [];
    const reasoning: string[] = [];
    if (this.buffer) {
      this.emit(this.buffer, content, reasoning);
      this.buffer = "";
    }
    return { content, reasoning };
  }

  private emit(text: string, content: string[], reasoning: string[]) {
    if (this.insideThink) {
      this.sawReasoning = true;
      reasoning.push(text);
    } else {
      content.push(text);
    }
  }

  private partialTagSuffixLength(tag: string): number {
    const max = Math.min(this.buffer.length, tag.length - 1);
    for (let len = max; len > 0; len--) {
      if (this.buffer.endsWith(tag.slice(0, len))) return len;
    }
    return 0;
  }
}

const TEXT_TOOL_MARKERS = [
  "<tool_call",
  "<toolcall",
  "<|tool_call",
  "<function=",
  "<function name=",
  "<｜dsml｜tool_calls",
  "<｜dsml｜invoke",
  "<|dsml|tool_calls",
  "<|dsml|invoke",
];

/** Suppress textual tool markup even when its opening marker spans chunks. */
export class TextToolMarkupFilter {
  private buffer = "";
  private suppressing = false;

  feed(text: string): string {
    if (this.suppressing || !text) return "";
    this.buffer += text;
    const lower = this.buffer.toLowerCase();
    let markerIndex = -1;
    for (const marker of TEXT_TOOL_MARKERS) {
      const index = lower.indexOf(marker);
      if (index >= 0 && (markerIndex < 0 || index < markerIndex)) {
        markerIndex = index;
      }
    }
    if (markerIndex >= 0) {
      const visible = this.buffer.slice(0, markerIndex);
      this.buffer = "";
      this.suppressing = true;
      return visible;
    }

    for (
      let index = lower.lastIndexOf("<");
      index >= 0;
      index = lower.lastIndexOf("<", index - 1)
    ) {
      const suffix = lower.slice(index);
      if (TEXT_TOOL_MARKERS.some((marker) => marker.startsWith(suffix))) {
        const visible = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index);
        return visible;
      }
    }
    const visible = this.buffer;
    this.buffer = "";
    return visible;
  }

  flush(): string {
    if (this.suppressing) return "";
    const visible = this.buffer;
    this.buffer = "";
    return visible;
  }
}

export function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .trim();
}

export function parseToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function deduplicateToolCalls(
  calls: NormalizedToolCall[],
): NormalizedToolCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.name}\n${JSON.stringify(call.input)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseTextToolCalls(
  text: string,
  iteration: number,
): NormalizedToolCall[] {
  const dsmlCalls = parseDsmlToolCalls(text, iteration);
  if (dsmlCalls.length) return deduplicateToolCalls(dsmlCalls);
  if (
    !/<(?:tool_call|toolcall)\b|<\|tool_call(?:_start)?\|>|<function(?:=|\s+name=)|(?:^|\n)\s*(?:tool|function|name)\s*[:=]/i.test(
      text,
    )
  )
    return [];
  const bodies: string[] = [];
  const tagPattern =
    /<(?:tool_call|toolcall)\b[^>]*>|<\|tool_call(?:_start)?\|>/gi;
  const openTags = [...text.matchAll(tagPattern)];
  for (const [index, openTag] of openTags.entries()) {
    const start = (openTag.index ?? 0) + openTag[0].length;
    const nextStart = openTags[index + 1]?.index ?? text.length;
    const segment = text.slice(start, nextStart);
    const closeIndex = segment.search(
      /<\/(?:tool_call|toolcall)>|<\|tool_call_end\|>/i,
    );
    bodies.push(closeIndex >= 0 ? segment.slice(0, closeIndex) : segment);
  }

  const calls = bodies.flatMap((body, bodyIndex): NormalizedToolCall[] => {
    const xmlStyleCall = parseXmlStyleToolCall(body, iteration, bodyIndex);
    if (xmlStyleCall) return [xmlStyleCall];
    try {
      const candidate = normalizeQwenToolMapSyntax(extractJsonCandidate(body));
      const parsed = JSON.parse(jsonrepair(candidate)) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const parsedCalls = rows.flatMap(
        (row, rowIndex): NormalizedToolCall[] => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return [];
          const record = row as Record<string, unknown>;
          const functionRecord =
            record.function &&
            typeof record.function === "object" &&
            !Array.isArray(record.function)
              ? (record.function as Record<string, unknown>)
              : null;
          const entries = Object.entries(record);
          const mapStyleCall =
            record.name == null &&
            functionRecord?.name == null &&
            entries.length === 1 &&
            entries[0][1] &&
            typeof entries[0][1] === "object" &&
            !Array.isArray(entries[0][1])
              ? entries[0]
              : null;
          const rawName =
            record.name ?? functionRecord?.name ?? mapStyleCall?.[0];
          const name = typeof rawName === "string" ? rawName.trim() : "";
          if (!name) return [];
          return [
            {
              id:
                typeof record.id === "string" && record.id
                  ? record.id
                  : `call_text_${iteration}_${bodyIndex}_${rowIndex}`,
              name,
              input: parseToolInput(
                record.arguments ??
                  record.input ??
                  record.parameters ??
                  functionRecord?.arguments ??
                  mapStyleCall?.[1],
              ),
            },
          ];
        },
      );
      const looseCall = parseLooseTextToolCall(body, iteration, bodyIndex);
      return parsedCalls.length ? parsedCalls : looseCall ? [looseCall] : [];
    } catch (error) {
      const looseCall = parseLooseTextToolCall(body, iteration, bodyIndex);
      if (looseCall) return [looseCall];
      if (process.env.DEBUG_LLM_TOOL_CALLS === "1") {
        console.error("[openai-compatible] unrecoverable textual tool call", {
          body: body.slice(0, 4_000),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw new Error(
        "The local model returned a tool call that Mike could not recover. Retry the request or use the deterministic Trademark Monitor mode.",
      );
    }
  });
  if (!calls.length) {
    throw new Error(
      "The local model did not identify an executable tool. Retry the request or use the deterministic Trademark Monitor mode.",
    );
  }
  return deduplicateToolCalls(calls);
}

export function parseDsmlToolCalls(
  value: string,
  iteration: number,
): NormalizedToolCall[] {
  if (!/<[｜|]DSML[｜|]invoke\b/i.test(value)) return [];
  const calls: NormalizedToolCall[] = [];
  const invokePattern =
    /<[｜|]DSML[｜|]invoke\s+name=["']?([^>"'\s]+)["']?\s*>([\s\S]*?)<\/[｜|]DSML[｜|]invoke\s*>/gi;
  for (const [index, invoke] of [...value.matchAll(invokePattern)].entries()) {
    const input: Record<string, unknown> = {};
    const parameterPattern =
      /<[｜|]DSML[｜|]parameter\s+name=["']?([^>"'\s]+)["']?(?:\s+[^>]*)?>([\s\S]*?)<\/[｜|]DSML[｜|]parameter\s*>/gi;
    for (const parameter of invoke[2].matchAll(parameterPattern)) {
      input[parameter[1]] = parseToolScalar(parameter[2]);
    }
    calls.push({
      id: `call_text_${iteration}_dsml_${index}`,
      name: invoke[1].trim(),
      input,
    });
  }
  return calls;
}

export function collapseTrademarkOwnerCalls(
  calls: NormalizedToolCall[],
): NormalizedToolCall[] {
  const groups = new Map<string, NormalizedToolCall[]>();
  for (const call of calls) {
    if (
      !call.name.startsWith("mcp_") ||
      !/tm_search_trademarks/i.test(call.name) ||
      typeof call.input.owner_name !== "string" ||
      !call.input.owner_name.trim()
    ) {
      continue;
    }
    const group = groups.get(call.name) ?? [];
    group.push(call);
    groups.set(call.name, group);
  }
  if (![...groups.values()].some((group) => group.length > 1)) return calls;

  const collapsed = new Set<NormalizedToolCall>();
  const replacements = new Map<string, NormalizedToolCall>();
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    const first = group[0];
    const ownerNames = group
      .map((call) => String(call.input.owner_name).trim())
      .filter(Boolean);
    replacements.set(name, {
      id: first.id,
      name,
      input: {
        ...first.input,
        owner_name: undefined,
        owner_names: ownerNames,
      },
    });
    group.forEach((call) => collapsed.add(call));
  }
  return calls.flatMap((call) => {
    if (!collapsed.has(call)) return [call];
    const replacement = replacements.get(call.name);
    if (!replacement || replacement.id !== call.id) return [];
    const input = Object.fromEntries(
      Object.entries(replacement.input).filter(
        ([, value]) => value !== undefined,
      ),
    );
    return [{ ...replacement, input }];
  });
}

function parseLooseTextToolCall(
  value: string,
  iteration: number,
  bodyIndex: number,
): NormalizedToolCall | null {
  const nameMatch = value.match(
    /(?:["']?name["']?|["']?(?:tool|function)["']?)\s*[:=]\s*["']?([^"'\s,}]+)["']?/i,
  );
  const name = nameMatch?.[1]?.trim();
  if (!name) return null;

  const input: Record<string, unknown> = {};
  const argumentsMatch = value.match(
    /["']?(?:arguments|input|parameters)["']?\s*[:=]\s*/i,
  );
  if (argumentsMatch && argumentsMatch.index != null) {
    const candidate = value.slice(
      argumentsMatch.index + argumentsMatch[0].length,
    );
    const repaired = normalizeQwenToolMapSyntax(
      extractJsonCandidate(candidate),
    );
    try {
      const parsed = JSON.parse(jsonrepair(repaired));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(input, parsed);
      }
    } catch {
      // A call with an unrecoverable argument payload is still returned so the
      // connector can provide its normal validation error instead of hiding the
      // model's tool name behind a generic parser failure.
    }
  }
  return {
    id: `call_text_${iteration}_${bodyIndex}_loose`,
    name,
    input,
  };
}

function parseXmlStyleToolCall(
  value: string,
  iteration: number,
  bodyIndex: number,
): NormalizedToolCall | null {
  const functionMatch = value.match(
    /<function(?:=|\s+name=["'])([^>"'\s]+)["']?\s*>/i,
  );
  if (!functionMatch) return null;
  const input: Record<string, unknown> = {};
  const fieldPattern = /<([a-zA-Z_][\w.-]*)>\s*([\s\S]*?)\s*<\/\1>/g;
  for (const match of value.matchAll(fieldPattern)) {
    input[match[1]] = parseToolScalar(match[2]);
  }
  return {
    id: `call_text_${iteration}_${bodyIndex}_xml`,
    name: functionMatch[1],
    input,
  };
}

export function parseToolScalar(value: string): unknown {
  const trimmed = value.trim();
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^(?:null|none)$/i.test(trimmed)) return null;
  if (/^[\[{]/.test(trimmed)) {
    try {
      return JSON.parse(jsonrepair(trimmed));
    } catch {
      // Preserve the original string when a nested value is not JSON-like.
    }
  }
  return trimmed;
}

export function normalizeQwenToolMapSyntax(value: string): string {
  return value
    .replace(/^(\s*\{\s*)"{2,}/, '$1"')
    .replace(/^(\s*\{\s*"[^"]+")\s*:{2,}/, "$1:");
}

export function extractJsonCandidate(value: string): string {
  const cleaned = value
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const start = cleaned.search(/[\[{]/);
  if (start < 0) return cleaned;

  const opening = cleaned[start];
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === opening) depth += 1;
    if (char === closing) {
      depth -= 1;
      if (depth === 0) return cleaned.slice(start, index + 1);
    }
  }
  return cleaned.slice(start);
}

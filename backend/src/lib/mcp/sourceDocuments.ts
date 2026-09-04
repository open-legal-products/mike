import type { SourceDocument } from "../sourceDocuments";

export const LEGAL_SOURCES_SCHEMA =
  "https://legaldatahunter.com/schemas/legal-sources/v1";
export const LEGAL_DATA_HUNTER_MCP_URL = "https://legaldatahunter.com/mcp";

const MAX_SOURCES_PER_RESULT = 3;
const MAX_SOURCE_ID_CHARS = 2_048;
const MAX_TITLE_CHARS = 500;
const MAX_TEXT_CHARS = 50_000;

export type ExternalLegalSource = {
  text: string;
  document: SourceDocument;
};

export type ExternalSourceStore = Map<string, ExternalLegalSource>;

type SourceContext = {
  connectorId: string;
  serverUrl: string;
};

type ToolContext = {
  toolName?: string;
  arguments?: Record<string, unknown>;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxChars ? normalized : null;
}

function httpsUrl(value: unknown): string | null {
  const candidate = text(value, MAX_SOURCE_ID_CHARS);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function sourceType(value: unknown): "case" | "legislation" | null {
  if (value === "case" || value === "case_law") return "case";
  if (
    value === "legislation" ||
    value === "regulation" ||
    value === "statute"
  ) {
    return "legislation";
  }
  return null;
}

export function normalizedMcpEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    const path = url.pathname
      .replace(/%6d/gi, "m")
      .replace(/%63/gi, "c")
      .replace(/%70/gi, "p")
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "");
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${hostname}:${port}${path}`;
  } catch {
    return null;
  }
}

function isLegalDataHunter(context: SourceContext): boolean {
  return (
    normalizedMcpEndpoint(context.serverUrl) ===
    normalizedMcpEndpoint(LEGAL_DATA_HUNTER_MCP_URL)
  );
}

function parsedTextBlocks(result: unknown): unknown[] {
  const value = record(result);
  const content = Array.isArray(value?.content) ? value.content : [];
  const parsed: unknown[] = [];
  for (const block of content) {
    const row = record(block);
    if (row?.type !== "text" || typeof row.text !== "string") continue;
    try {
      parsed.push(JSON.parse(row.text));
    } catch {
      // Only complete JSON blocks are eligible source payloads.
    }
  }
  return parsed;
}

function sourceDocument(
  raw: UnknownRecord,
  context: SourceContext,
): ExternalLegalSource | null {
  const id = text(raw.source_id, MAX_SOURCE_ID_CHARS);
  const type = sourceType(raw.source_type);
  const title = text(raw.title, MAX_TITLE_CHARS);
  const canonicalText = text(raw.text, MAX_TEXT_CHARS);
  if (!id || !type || !title || !canonicalText) return null;

  const documentId = `mcp:${context.connectorId}:${id}`;
  const metadata = [
    ["Citation", text(raw.citation, MAX_TITLE_CHARS)],
    ["Jurisdiction", text(raw.jurisdiction, MAX_TITLE_CHARS)],
    ["Date", text(raw.date, MAX_TITLE_CHARS)],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => ({
      label,
      value,
      ...(label === "Date" ? { format: "date" as const } : {}),
    }));
  const officialUrl = httpsUrl(raw.official_url);

  return {
    text: canonicalText,
    document: {
      document_id: documentId,
      title,
      type,
      metadata,
      ...(officialUrl
        ? {
            actions: [
              {
                type: "link" as const,
                url: officialUrl,
                label: "Official source",
                title: "Official source",
              },
            ],
          }
        : {}),
      quotes: [],
      subdocuments: [
        {
          document_id: `${documentId}:text`,
          title,
          type: "html",
          text: canonicalText,
        },
      ],
    },
  };
}

function versionedSources(
  envelope: UnknownRecord,
  context: SourceContext,
): ExternalLegalSource[] | null {
  if (!("schema" in envelope)) return null;
  if (envelope.schema !== LEGAL_SOURCES_SCHEMA) return [];
  if (!Array.isArray(envelope.sources)) return [];
  const sources: ExternalLegalSource[] = [];
  const seenIds = new Set<string>();
  for (const value of envelope.sources) {
    const raw = record(value);
    if (!raw || raw.citation_ready !== true) continue;
    const source = sourceDocument(raw, context);
    if (!source || seenIds.has(source.document.document_id)) continue;
    seenIds.add(source.document.document_id);
    sources.push(source);
    if (sources.length === MAX_SOURCES_PER_RESULT) break;
  }
  return sources;
}

function canonicalLegalDataHunterSource(
  value: unknown,
  context: SourceContext,
  tool: ToolContext,
): ExternalLegalSource | null {
  if (!isLegalDataHunter(context) || tool.toolName !== "get_document") {
    return null;
  }
  const raw = record(value);
  if (!raw) return null;

  const provider = text(raw.source, MAX_SOURCE_ID_CHARS);
  const providerId = text(raw.source_id, MAX_SOURCE_ID_CHARS);
  const type = sourceType(raw.data_type ?? raw.source_type);
  const title = text(raw.title, MAX_TITLE_CHARS);
  const canonicalText = text(raw.full_text ?? raw.text, MAX_TEXT_CHARS);
  if (!provider || !providerId || !type || !title || !canonicalText) {
    return null;
  }

  const requestedSource = text(tool.arguments?.source, MAX_SOURCE_ID_CHARS);
  const requestedId = text(tool.arguments?.source_id, MAX_SOURCE_ID_CHARS);
  if (
    (requestedSource && requestedSource !== provider) ||
    (requestedId && requestedId !== providerId)
  ) {
    return null;
  }

  return sourceDocument(
    {
      source_id: `${provider}:${providerId}`,
      source_type: type,
      title,
      text: canonicalText,
      citation: raw.citation ?? raw.case_number ?? raw.ecli ?? raw.identifier,
      jurisdiction: raw.jurisdiction ?? raw.court,
      date: raw.date ?? raw.decision_date,
      official_url: raw.official_url ?? raw.url,
    },
    context,
  );
}

export function extractExternalLegalSources(
  result: unknown,
  context: SourceContext,
  wasTruncated = false,
  tool: ToolContext = {},
): ExternalLegalSource[] {
  const root = record(result);
  if (
    wasTruncated ||
    root?.isError === true ||
    !isLegalDataHunter(context) ||
    tool.toolName !== "get_document"
  ) {
    return [];
  }
  const structured = record(root?.structuredContent);
  if (structured && "schema" in structured) {
    return versionedSources(structured, context) ?? [];
  }

  const candidates = [structured, ...parsedTextBlocks(result)].filter(
    (value): value is UnknownRecord => value !== null,
  );
  for (const candidate of candidates) {
    const versioned = versionedSources(candidate, context);
    if (versioned !== null) return versioned;
  }

  for (const candidate of parsedTextBlocks(result)) {
    const source = canonicalLegalDataHunterSource(candidate, context, tool);
    if (source) return [source];
  }
  return [];
}

export type RegisteredExternalSource = {
  handle: string;
  documentId: string;
  type: "case" | "legislation";
};

export function registerExternalLegalSources(
  store: ExternalSourceStore,
  sources: ExternalLegalSource[],
): RegisteredExternalSource[] {
  const registered: RegisteredExternalSource[] = [];
  for (const source of sources) {
    const existing = [...store.entries()].find(
      ([, value]) => value.document.document_id === source.document.document_id,
    );
    let handle = existing?.[0];
    if (existing) {
      const stored = existing[1];
      if (
        stored.text !== source.text ||
        stored.document.title !== source.document.title ||
        stored.document.type !== source.document.type
      ) {
        continue;
      }
    } else {
      handle = `source-${store.size}`;
      store.set(handle, source);
    }
    registered.push({
      handle: handle as string,
      documentId: source.document.document_id,
      type: source.document.type as "case" | "legislation",
    });
  }
  return registered;
}

export function buildExternalSourceCitationReminder(
  registered: RegisteredExternalSource[],
): string {
  if (!registered.length) return "";
  return [
    "Citation-ready canonical legal sources:",
    ...registered.map(({ handle }) => `- {"doc_id":"${handle}"}`),
    "Cite an exact quote from the canonical document text with the matching doc_id.",
    "Use only these source handles for MCP legal citations. Do not cite search previews or provider URLs as documents.",
  ].join("\n");
}

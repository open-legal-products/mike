import { normalizeCaseDocument } from "../../../../lib/sourceDocuments";
import type { CaseCitationEvent } from "./courtlistenerTools";
import { convert } from "html-to-text";

export type CourtlistenerCaseRecord = {
  clusterId: number;
  caseName: string | null;
  citations: string[];
  url: string | null;
  pdfUrl: string | null;
  dateFiled: string | null;
  opinions?: unknown[];
};

export type CourtlistenerCaseInput = {
  clusterId?: number | null;
  caseName?: string | null;
  citation?: string | null;
  citations?: string[];
  url?: string | null;
  pdfUrl?: string | null;
  dateFiled?: string | null;
  opinions?: unknown[];
};

export type CourtlistenerTurnState = {
  casesByClusterId: Map<number, CourtlistenerCaseRecord>;
};

export type CachedCaseOpinionText = {
  opinion_id: number | null;
  type: string | null;
  author: string | null;
  url: string | null;
  text: string;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function recordFromUnknown(
  value: unknown,
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function numberField(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function stringArrayField(
  record: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stripOpinionHtml(value: string): string {
  return convert(value, {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  })
    .replace(/\s+/g, " ")
    .trim();
}

function opinionText(opinion: Record<string, unknown>): string | null {
  const text = stringField(opinion, "text");
  const html = stringField(opinion, "html");
  return text ?? (html ? stripOpinionHtml(html) : null);
}

export function upsertCourtlistenerCases(
  state: CourtlistenerTurnState,
  inputs: CourtlistenerCaseInput[],
): CourtlistenerCaseRecord[] {
  const records: CourtlistenerCaseRecord[] = [];
  for (const input of inputs) {
    if (
      typeof input.clusterId !== "number" ||
      !Number.isFinite(input.clusterId)
    ) {
      continue;
    }
    const clusterId = Math.floor(input.clusterId);
    const current = state.casesByClusterId.get(clusterId) ?? {
      clusterId,
      caseName: null,
      citations: [],
      url: null,
      pdfUrl: null,
      dateFiled: null,
    };
    const nextCitations = [
      ...current.citations,
      ...(input.citation ? [input.citation] : []),
      ...(input.citations ?? []),
    ]
      .map(nonEmpty)
      .filter((value): value is string => !!value);
    const record: CourtlistenerCaseRecord = {
      ...current,
      caseName: current.caseName ?? nonEmpty(input.caseName),
      citations: Array.from(new Set(nextCitations)),
      url: current.url ?? nonEmpty(input.url),
      pdfUrl: current.pdfUrl ?? nonEmpty(input.pdfUrl),
      dateFiled: current.dateFiled ?? nonEmpty(input.dateFiled),
      opinions: input.opinions?.length ? input.opinions : current.opinions,
    };
    state.casesByClusterId.set(clusterId, record);
    records.push(record);
  }
  return records;
}

export function caseCitationEventFromRecord(
  record: CourtlistenerCaseRecord,
): CaseCitationEvent | null {
  if (!record.url) return null;
  return {
    type: "case_citation",
    cluster_id: record.clusterId,
    case_name: record.caseName,
    citation: record.citations[0] ?? null,
    url: record.url,
    pdfUrl: record.pdfUrl,
    dateFiled: record.dateFiled,
    document: normalizeCaseDocument({
      clusterId: record.clusterId,
      caseName: record.caseName,
      citations: record.citations,
      url: record.url,
      pdfUrl: record.pdfUrl,
      dateFiled: record.dateFiled,
    }),
  };
}

export function courtlistenerCaseInputFromFetchedCase(
  fallbackClusterId: number,
  fetchedCase: unknown,
): CourtlistenerCaseInput {
  const record = recordFromUnknown(fetchedCase);
  return {
    clusterId:
      numberField(record, "clusterId") ??
      numberField(record, "id") ??
      fallbackClusterId,
    caseName: stringField(record, "caseName"),
    citations: stringArrayField(record, "citations"),
    url: stringField(record, "url"),
    pdfUrl: stringField(record, "pdfUrl"),
    dateFiled: stringField(record, "dateFiled"),
    opinions: Array.isArray(record?.opinions) ? record.opinions : undefined,
  };
}

export function courtlistenerOpinionCount(fetchedCase: unknown): number {
  const record = recordFromUnknown(fetchedCase);
  return Array.isArray(record?.opinions) ? record.opinions.length : 0;
}

export function courtlistenerOpinionMetadata(raw: unknown) {
  const opinion = recordFromUnknown(raw);
  if (!opinion) return null;
  return {
    opinion_id: numberField(opinion, "opinionId") ?? numberField(opinion, "id"),
    type: stringField(opinion, "type"),
    author: stringField(opinion, "author"),
    per_curiam: stringField(opinion, "per_curiam"),
    joined_by_str: stringField(opinion, "joined_by_str"),
    url: stringField(opinion, "url"),
    char_count: opinionText(opinion)?.length ?? 0,
  };
}

export function courtlistenerFetchedCaseMetadata(
  record: CourtlistenerCaseRecord,
  opinionCount: number,
) {
  return {
    cluster_id: record.clusterId,
    case_name: record.caseName,
    citation: record.citations[0] ?? null,
    citations: record.citations,
    dateFiled: record.dateFiled,
    url: record.url,
    pdfUrl: record.pdfUrl,
    opinion_count: opinionCount,
    opinions: (record.opinions ?? [])
      .map(courtlistenerOpinionMetadata)
      .filter((opinion): opinion is NonNullable<typeof opinion> => !!opinion),
  };
}

export function cachedCaseOpinionTexts(
  record: CourtlistenerCaseRecord,
): CachedCaseOpinionText[] {
  return (record.opinions ?? [])
    .map((raw) => {
      const opinion = recordFromUnknown(raw);
      if (!opinion) return null;
      const text = opinionText(opinion);
      if (!text) return null;
      return {
        opinion_id:
          numberField(opinion, "opinionId") ?? numberField(opinion, "id"),
        type: stringField(opinion, "type"),
        author: stringField(opinion, "author"),
        url: stringField(opinion, "url"),
        text,
      };
    })
    .filter((opinion): opinion is CachedCaseOpinionText => !!opinion);
}

export function getCachedCaseOpinionTexts(
  state: CourtlistenerTurnState,
  clusterId: number,
): CachedCaseOpinionText[] {
  const record = state.casesByClusterId.get(clusterId);
  return record ? cachedCaseOpinionTexts(record) : [];
}

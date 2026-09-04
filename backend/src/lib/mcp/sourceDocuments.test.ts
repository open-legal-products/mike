import { describe, expect, it } from "vitest";
import {
  LEGAL_DATA_HUNTER_MCP_URL,
  LEGAL_SOURCES_SCHEMA,
  buildExternalSourceCitationReminder,
  extractExternalLegalSources,
  registerExternalLegalSources,
  type ExternalSourceStore,
} from "./sourceDocuments";

const PROVENANCE = {
  connectorId: "connector-1",
  serverUrl: LEGAL_DATA_HUNTER_MCP_URL,
};

function legalSource(overrides: Record<string, unknown> = {}) {
  return {
    source_id: "legal-data-hunter:case:ccass-2025-001",
    source_type: "case",
    title: "Cour de cassation, chambre commerciale",
    citation: "Pourvoi n° 24-10.001",
    jurisdiction: "Cour de cassation",
    date: "2025-01-15",
    official_url: "https://www.legifrance.gouv.fr/example",
    text: "Attendu que la Cour rejette le pourvoi.",
    citation_ready: true,
    ...overrides,
  };
}

function versionedResult(sources: unknown[]) {
  return {
    content: [{ type: "text", text: "Legacy MCP result" }],
    structuredContent: {
      schema: LEGAL_SOURCES_SCHEMA,
      sources,
    },
  };
}

describe("external legal-source extraction", () => {
  it("normalizes a citation-ready versioned source", () => {
    const sources = extractExternalLegalSources(
      versionedResult([legalSource()]),
      PROVENANCE,
      false,
      { toolName: "get_document" },
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      text: "Attendu que la Cour rejette le pourvoi.",
      document: {
        document_id: "mcp:connector-1:legal-data-hunter:case:ccass-2025-001",
        title: "Cour de cassation, chambre commerciale",
        type: "case",
        metadata: [
          { label: "Citation", value: "Pourvoi n° 24-10.001" },
          { label: "Jurisdiction", value: "Cour de cassation" },
          { label: "Date", value: "2025-01-15", format: "date" },
        ],
        actions: [
          {
            type: "link",
            url: "https://www.legifrance.gouv.fr/example",
            label: "Official source",
            title: "Official source",
          },
        ],
        subdocuments: [
          expect.objectContaining({
            type: "html",
            text: "Attendu que la Cour rejette le pourvoi.",
          }),
        ],
      },
    });
  });

  it("normalizes trusted canonical get_document JSON when the SDK also returns schema-less structured content", () => {
    const payload = {
      source: "FR/CASS",
      source_id: "JURITEXT000006994248",
      data_type: "case_law",
      title: "Cour de cassation, 27 octobre 1975",
      text: "Full canonical judgment text.",
      url: "https://www.legifrance.gouv.fr/juri/id/JURITEXT000006994248",
      country: "FR",
      court: "Cour de cassation",
      date: "1975-10-27",
      ecli: "ECLI:FR:CCASS:1975:TEST",
    };

    const sources = extractExternalLegalSources(
      {
        structuredContent: payload,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      },
      PROVENANCE,
      false,
      { toolName: "get_document" },
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      text: "Full canonical judgment text.",
      document: {
        title: "Cour de cassation, 27 octobre 1975",
        type: "case",
        metadata: [
          { label: "Citation", value: "ECLI:FR:CCASS:1975:TEST" },
          { label: "Jurisdiction", value: "Cour de cassation" },
          { label: "Date", value: "1975-10-27", format: "date" },
        ],
      },
    });
    expect(registerExternalLegalSources(new Map(), sources)).toEqual([
      expect.objectContaining({ handle: "source-0", type: "case" }),
    ]);
  });

  it("does not register LDH search previews as canonical citation sources", () => {
    const payload = {
      hits: [
        {
          source: "FR/CASS",
          source_id: "JURITEXT000006994248",
          title: "Cour de cassation, 27 octobre 1975",
          snippet: "Search preview only.",
        },
      ],
    };

    expect(
      extractExternalLegalSources(
        {
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
        PROVENANCE,
        false,
        { toolName: "search" },
      ),
    ).toEqual([]);
    expect(
      extractExternalLegalSources(
        versionedResult([legalSource()]),
        PROVENANCE,
        false,
        { toolName: "search" },
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "an explicit unknown schema",
      { structuredContent: { schema: "unknown" } },
    ],
    ["a truncated result", versionedResult([legalSource()]), true],
    [
      "an untrusted connector",
      versionedResult([legalSource()]),
      false,
      "https://attacker.example/mcp",
    ],
    ["an MCP error", { ...versionedResult([legalSource()]), isError: true }],
  ])(
    "rejects %s",
    (
      _label,
      result,
      truncated = false,
      serverUrl = LEGAL_DATA_HUNTER_MCP_URL,
    ) => {
      expect(
        extractExternalLegalSources(
          result,
          { connectorId: "connector-1", serverUrl },
          truncated,
          { toolName: "get_document" },
        ),
      ).toEqual([]);
    },
  );
});

describe("turn-scoped external source registration", () => {
  it("assigns stable short handles and rejects conflicting redefinitions", () => {
    const store: ExternalSourceStore = new Map();
    const [source] = extractExternalLegalSources(
      versionedResult([legalSource()]),
      PROVENANCE,
      false,
      { toolName: "get_document" },
    );

    expect(registerExternalLegalSources(store, [source])).toEqual([
      expect.objectContaining({ handle: "source-0", type: "case" }),
    ]);
    expect(registerExternalLegalSources(store, [source])[0]?.handle).toBe(
      "source-0",
    );
    expect(
      registerExternalLegalSources(store, [
        {
          ...source,
          text: "Conflicting text.",
          document: { ...source.document, title: "Conflicting title" },
        },
      ]),
    ).toEqual([]);
  });

  it("builds Mike-authored citation instructions without provider titles", () => {
    const reminder = buildExternalSourceCitationReminder([
      {
        handle: "source-0",
        documentId: "mcp:connector-1:source-id",
        title: "Untrusted provider title",
        type: "case",
      },
    ]);

    expect(reminder).toContain('"doc_id":"source-0"');
    expect(reminder).not.toContain("Untrusted provider title");
  });
});

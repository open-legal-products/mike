import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../lib/supabase";

const mocks = vi.hoisted(() => ({
  getCourtlistenerCaseOpinions: vi.fn(),
  getUserModelSettings: vi.fn(),
}));

vi.mock("../../lib/courtlistener", async (original) => ({
  ...(await original<typeof import("../../lib/courtlistener")>()),
  getCourtlistenerCaseOpinions: mocks.getCourtlistenerCaseOpinions,
}));
vi.mock("../user/user.service", () => ({
  getUserModelSettings: mocks.getUserModelSettings,
}));

import { COURTLISTENER_TOKEN_REQUIRED_MESSAGE } from "../../lib/courtlistener";
import {
  externalSourceFromMcpCall,
  getSourceDocument,
  isExternalSourceDocumentId,
  sourceProviderFor,
} from "./sourceDocuments.providers";
import { COURTLISTENER_CREDENTIAL_DETAIL } from "./sourceDocuments.courtlistener";

const db = {} as Db;

describe("source provider registry", () => {
  beforeEach(() => {
    mocks.getCourtlistenerCaseOpinions.mockReset();
    mocks.getUserModelSettings.mockReset();
    mocks.getUserModelSettings.mockResolvedValue({ api_keys: { courtlistener: "token" } });
  });

  it("routes case ids to CourtListener and knows nothing else", () => {
    expect(sourceProviderFor("case:123")?.id).toBe("courtlistener");
    expect(sourceProviderFor("case:0")).toBeNull();
    expect(sourceProviderFor("doc-1")).toBeNull();
    expect(isExternalSourceDocumentId("case:7")).toBe(true);
    expect(isExternalSourceDocumentId("3f2a")).toBe(false);
  });

  it("answers not_found for an id no provider owns", async () => {
    await expect(
      getSourceDocument(db, { userId: "u1", documentId: "unknown:1" }),
    ).resolves.toEqual({ ok: false, kind: "not_found", detail: "Document not found" });
    expect(mocks.getCourtlistenerCaseOpinions).not.toHaveBeenCalled();
  });

  it("hydrates a case through its provider with the workspace's token", async () => {
    mocks.getCourtlistenerCaseOpinions.mockResolvedValue({
      caseName: "Example v Example",
      citations: ["1 U.S. 1"],
      opinions: [{ id: 5, type: "lead", html: "<p>Text</p>" }],
    });
    const result = await getSourceDocument(db, {
      userId: "u1",
      documentId: "case:123",
      orgId: "org-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.document_id).toBe("case:123");
    expect(result.document.title).toBe("Example v Example, 1 U.S. 1");
    expect(mocks.getUserModelSettings).toHaveBeenCalledWith("u1", db, { orgId: "org-1" });
    expect(mocks.getCourtlistenerCaseOpinions).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: 123, apiToken: "token" }),
    );
  });

  it("maps a rejected token onto the fixed credentials detail", async () => {
    mocks.getCourtlistenerCaseOpinions.mockRejectedValue(
      new Error(COURTLISTENER_TOKEN_REQUIRED_MESSAGE),
    );
    await expect(
      getSourceDocument(db, { userId: "u1", documentId: "case:123" }),
    ).resolves.toEqual({
      ok: false,
      kind: "credentials",
      detail: COURTLISTENER_CREDENTIAL_DETAIL,
    });
  });

  it("keeps any other provider failure as an error result", async () => {
    const failure = new Error("CourtListener error (500): boom");
    mocks.getCourtlistenerCaseOpinions.mockRejectedValue(failure);
    await expect(
      getSourceDocument(db, { userId: "u1", documentId: "case:123" }),
    ).resolves.toEqual({ ok: false, kind: "error", error: failure });
  });

  it("shares one provider fetch between concurrent requests for the same document", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.getCourtlistenerCaseOpinions.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const args = { userId: "u1", documentId: "case:9" };
    const first = getSourceDocument(db, args);
    const second = getSourceDocument(db, args);
    const other = getSourceDocument(db, { ...args, userId: "u2" });
    await Promise.resolve();
    release({ opinions: [] });
    const [a, b] = await Promise.all([first, second, other]);
    expect(a).toBe(b);
    expect(mocks.getCourtlistenerCaseOpinions).toHaveBeenCalledTimes(2);
    // Settled entries are dropped: the next request fetches again.
    await getSourceDocument(db, args);
    expect(mocks.getCourtlistenerCaseOpinions).toHaveBeenCalledTimes(3);
  });

  it("recognises no citable source in an MCP result until a provider claims it", () => {
    expect(
      externalSourceFromMcpCall({
        connectorId: "c1",
        serverUrl: "https://example.com/mcp",
        toolName: "get_document",
        arguments: {},
        result: { content: [{ type: "text", text: "{}" }] },
      }),
    ).toBeNull();
  });
});

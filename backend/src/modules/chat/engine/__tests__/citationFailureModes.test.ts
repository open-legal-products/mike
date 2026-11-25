/**
 * Ways an inline-cited answer can lose its citations, replayed through
 * runLLMStream with a scripted model. Each citation is written with its
 * claim, so a cut-off or stopped answer loses at most the tag being written.
 * (cite_sources' own failure modes are covered in streamingCitations.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamCallbacks } from "../../../../lib/llm/types";

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../tools/toolDispatcher", () => ({ runToolCalls: vi.fn() }));
vi.mock("../../../../lib/integrations/googleDrive", () => ({ buildGoogleDriveTools: async () => [] }));
vi.mock("../../../../lib/integrations/googleWorkspace", () => ({ buildGoogleWorkspaceTools: async () => [] }));
vi.mock("../../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/documentVersions")>()),
  loadActiveVersion: async () => ({
    id: "version-1", version_number: 1, storage_path: "synthetic/lease.txt",
  }),
}));

import { AssistantStreamError, runLLMStream, throwIfTurnStopped } from "../streaming";
import { assessCitationHealth } from "../citationHealth";
import { rememberReadText, segmentPassages } from "../inlineCitations";
import type { CitationFormat } from "../inlineCitations";

type StreamChatCall = {
  callbacks?: StreamCallbacks & { onStopNotice?: (notice: string) => void };
  signal?: AbortSignal;
};

const LEASE = `[Page 1]
1. TERM
1.1 The term of this Lease is ten years starting on 1 April 2025.

[Page 2]
2. RENT
2.1 The initial annual rent is £186,000 exclusive of VAT.
2.2 The Tenant shall have a rent-free period of six months.`;

const PASSAGES = segmentPassages(LEASE);
const idOf = (words: string) => PASSAGES.find((p) => p.text.includes(words))!.id;
const TERM = idOf("ten years");
const RENT = idOf("£186,000");
const RENT_FREE = idOf("rent-free");

/** A three-claim answer with a tag after each claim. */
const PROSE = `The term is ten years [[doc-0 ${TERM}]]. The rent is £186,000 [[doc-0 ${RENT}]]. There is a six-month rent-free period [[doc-0 ${RENT_FREE}]].`;
const NOTICE = "\n\n_Stopped early: this response reached the model's output limit._";

function params(format: CitationFormat) {
  const docStore = new Map([["doc-0", {
    filename: "Lease.txt", file_type: "txt", storage_path: "synthetic/lease.txt", inline_text: LEASE,
  }]]);
  // As read_document does when it hands the model the tagged text.
  if (format === "inline") rememberReadText(docStore, "doc-0", LEASE);
  return {
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "user" as const, content: "Summarise the lease." }],
    docStore,
    docIndex: { "doc-0": {
      filename: "Lease.txt", document_id: "document-1", version_id: "version-1", version_number: 1,
    } },
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    nonce: "turnnonce",
    citationFormat: format,
  };
}

/** Streams `text` in small deltas; optionally ends with a notice or a stop. */
function script(text: string, end: { notice?: string; stopAfter?: number } = {}) {
  streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
    const upTo = end.stopAfter ?? text.length;
    for (let i = 0; i < upTo; i += 7) {
      callbacks?.onContentDelta?.(text.slice(i, Math.min(i + 7, upTo)));
    }
    if (end.stopAfter !== undefined) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    if (end.notice) callbacks?.onStopNotice?.(end.notice);
    return { fullText: text.slice(0, upTo) + (end.notice ?? "") };
  });
}

/** What the turn shows and keeps, as the chat route would store it. */
async function run(format: CitationFormat, text: string, end?: Parameters<typeof script>[1]) {
  script(text, end);
  const p = params(format);
  let visible: string;
  let citations: unknown[];
  let outcome: "completed" | "stopped";
  try {
    const result = await runLLMStream(p);
    visible = result.events.flatMap((e) => (e.type === "content" ? [e.text] : [])).join("");
    citations = result.citations;
    outcome = "completed";
  } catch (error) {
    if (!(error instanceof AssistantStreamError)) throw error;
    visible = error.events.flatMap((e) => (e.type === "content" ? [e.text] : [])).join("");
    // The route's stop path: the citations come with the error.
    citations = error.citations;
    outcome = "stopped";
  }
  const health = assessCitationHealth({
    format, outcome, surface: "chat", visibleText: visible, citations,
  });
  return { visible, citations, health };
}

beforeEach(() => vi.clearAllMocks());

describe("inline citation failure modes", () => {
  it.each([
    { tag: '[[doc-0 3]]', quote: "Rent is due.", offset: 9, stop: false },
    { tag: '[[doc-0 3 "IS DUE."]]', quote: "is due.", offset: 13, stop: true },
  ])("keeps the selected PDF occurrence while streaming and on completion or stop ($tag)", async ({ tag, quote, offset, stop }) => {
    const p = params("inline");
    const text = "[Page 1]\nRent is due.\n\n[Page 2]\nRent is due.\n\nRent is due.";
    Object.assign(p.docStore.get("doc-0")!, { filename: "Lease.pdf", file_type: "pdf", inline_text: text });
    p.docIndex["doc-0"].filename = "Lease.pdf";
    rememberReadText(p.docStore, "doc-0", text);
    script(tag, stop ? { stopAfter: tag.length } : {});
    const citations = await runLLMStream(p).then(result => result.citations, error => {
      if (!stop || !(error instanceof AssistantStreamError)) throw error;
      return error.citations;
    });
    const start = text.lastIndexOf(quote);
    const verification = {
      verified: true, start_char: start, end_char: start + quote.length, pdf_text_offset: offset,
    };
    const expected = {
      version_id: "version-1",
      quotes: [{ page: 2, quote, verification }],
      document: { quotes: [{ target: { page: 2 }, quote, verification }] },
    };
    const partial = p.write.mock.calls
      .filter(([frame]) => frame.startsWith("data: {"))
      .map(([frame]) => JSON.parse(frame.slice("data: ".length)))
      .find(frame => frame.status === "partial" && frame.citations?.length);
    expect(partial?.citations).toMatchObject([expected]);
    expect(citations).toMatchObject([expected]);
  });

  it("keeps every citation when the answer completes", async () => {
    const inline = await run("inline", PROSE);
    expect(inline.health).toMatchObject({ markers: 3, citations: 3, danglingMarkers: 0 });
    expect(inline.visible).toBe(
      "The term is ten years [1]. The rent is £186,000 [2]. There is a six-month rent-free period [3].",
    );
  });

  it("a length cut loses only the tag being written", async () => {
    const cut = PROSE.lastIndexOf("[[") + 6; // inside the third tag
    const inline = await run("inline", PROSE.slice(0, cut), { notice: NOTICE });
    expect(inline.health).toMatchObject({ markers: 2, citations: 2, danglingMarkers: 0 });
    expect(inline.visible).not.toContain("[[");
  });

  it("a Stop during the answer keeps the citations already written", async () => {
    const inline = await run("inline", PROSE, { stopAfter: PROSE.indexOf("There is") });
    expect(inline.health).toMatchObject({ markers: 2, citations: 2, danglingMarkers: 0 });
  });

  it("inline: a tag naming a passage that does not exist gets no marker", async () => {
    const inline = await run("inline", "The term is ten years [[doc-0 999]]. The rent is £186,000 [[doc-0 " + RENT + "]].");
    expect(inline.visible).toBe("The term is ten years. The rent is £186,000 [1].");
    expect(inline.health).toMatchObject({ markers: 1, citations: 1, danglingMarkers: 0 });
  });

  it("inline: citations resolve to the passage text, verified, with its page", async () => {
    const inline = await run("inline", PROSE);
    const [first, second] = inline.citations as {
      ref: number; quotes: { page: number; quote: string; verification?: { verified: boolean } }[];
      inline_locator?: string;
    }[];
    expect(first.quotes[0]).toMatchObject({ page: 1, verification: { verified: true } });
    expect(first.quotes[0].quote).toContain("The term of this Lease is ten years");
    expect(second.quotes[0].page).toBe(2);
    expect(first.inline_locator).toBe(String(TERM));
  });

  it("a Stop seen just after the stream returned keeps the citations it is given", () => {
    const stop = new AbortController();
    stop.abort();
    let thrown: unknown;
    try {
      throwIfTurnStopped(stop.signal, { fullText: "A [1].", events: [], citations: [{ ref: 1 }] });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AssistantStreamError).citations).toEqual([{ ref: 1 }]);
  });

  it("inline: a repeated source reuses its number", async () => {
    const inline = await run("inline", `A [[doc-0 ${TERM}]]. B [[doc-0 ${RENT}]]. C [[doc-0 ${TERM}]].`);
    expect(inline.visible).toBe("A [1]. B [2]. C [1].");
    expect(inline.citations).toHaveLength(2);
  });
});

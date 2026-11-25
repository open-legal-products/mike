/**
 * Inline citations around tool calls. Passage labels such as {34} are only
 * for the model to read and citation tags only belong in the chat answer,
 * so neither may reach a document the assistant creates or edits: a label
 * copied into an edit's find text makes the edit miss, and a tag copied into
 * a drafted document would land in the user's file as raw syntax. While the
 * answer streams, each citation is sent as soon as its tag is written, so
 * its marker can be opened before the answer ends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamCallbacks } from "../../../../lib/llm/types";
import { emptyToolCallBatchResult } from "../tools/toolBatchResult";

type RunToolsFn = (
  calls: { id: string; name: string; input: Record<string, unknown> }[],
) => Promise<unknown>;
type StreamChatCall = { callbacks?: StreamCallbacks; runTools?: RunToolsFn };

const { streamChatWithTools, runToolCalls } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  runToolCalls: vi.fn(),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../tools/toolDispatcher", () => ({ runToolCalls }));
vi.mock("../../../../lib/integrations/googleDrive", () => ({ buildGoogleDriveTools: async () => [] }));
vi.mock("../../../../lib/integrations/googleWorkspace", () => ({ buildGoogleWorkspaceTools: async () => [] }));
vi.mock("../../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/documentVersions")>()),
  loadActiveVersion: async () => ({
    id: "version-1", version_number: 1, storage_path: "synthetic/lease.txt",
  }),
}));

import { runLLMStream } from "../streaming";
import { rememberReadText, segmentPassages } from "../inlineCitations";

const LEASE = `[Page 5]
10. BREAK CLAUSE
10.1 The Tenant may terminate this Lease on 31 March 2030 by giving not less than nine months' written notice.
10.2 A notice is only effective if all rent is paid.`;
const BREAK = segmentPassages(LEASE).find((p) => p.text.startsWith("10.1"))!.id;

function params() {
  const docStore = new Map([["doc-0", {
    filename: "Albion House lease.pdf", file_type: "pdf", storage_path: "synthetic/lease.txt", inline_text: LEASE,
  }]]);
  rememberReadText(docStore, "doc-0", LEASE);
  return {
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "user" as const, content: "Draft a memo." }],
    docStore,
    docIndex: { "doc-0": {
      filename: "Albion House lease.pdf", document_id: "document-1", version_id: "version-1", version_number: 1,
    } },
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    nonce: "turnnonce",
    citationFormat: "inline" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runToolCalls.mockImplementation(async (calls: { id: string }[]) => {
    const result = emptyToolCallBatchResult();
    for (const call of calls) {
      result.toolResults.push({ role: "tool", tool_call_id: call.id, content: "ok" });
    }
    return result;
  });
});

/** The arguments each document tool was called with. */
function argsOf(name: string): Record<string, unknown> {
  const calls = (runToolCalls.mock.calls as unknown[][]).flatMap(
    (args) => args[0] as { function: { name: string; arguments: string } }[],
  );
  const call = calls.find((c) => c.function.name === name);
  if (!call) throw new Error(`${name} was not called`);
  return JSON.parse(call.function.arguments);
}

describe("inline citations and document tools", () => {
  it("strips passage labels and citation tags from what document tools receive", async () => {
    streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      await runTools?.([
        {
          id: "edit-1",
          name: "edit_document",
          input: {
            doc_id: "doc-0",
            edits: [{ find: `{${BREAK}}10.1 The Tenant may terminate this Lease`, replace: "10.1 The Tenant may end this Lease" }],
          },
        },
        {
          id: "draft-1",
          name: "generate_docx",
          input: {
            title: "Break memo",
            sections: [{ heading: "Notice", content: `The Tenant must give nine months' written notice [[doc-0 ${BREAK}]].` }],
          },
        },
      ]);
      return { fullText: "" };
    });

    await runLLMStream(params());

    const edit = argsOf("edit_document") as { edits: { find: string }[] };
    expect(edit.edits[0].find).toBe("10.1 The Tenant may terminate this Lease");
    const draft = JSON.stringify(argsOf("generate_docx"));
    expect(draft).not.toMatch(/\[\[|\{\d+\}/);
    // The citation stays readable in the document as a plain reference.
    expect(draft).toContain("nine months' written notice (Albion House lease.pdf, p. 5).");
  });

  it("sends each citation while the answer streams, so its marker opens before the end", async () => {
    const p = params();
    streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
      callbacks?.onContentDelta?.(`Notice is nine months [[doc-0 ${BREAK}]]. `);
      callbacks?.onContentDelta?.("More prose follows.");
      return { fullText: "" };
    });

    await runLLMStream(p);

    const frames = (p.write.mock.calls as unknown[][])
      .map((args) => args[0] as string)
      .filter((chunk: string) => chunk.startsWith("data: {"))
      .map((chunk: string) => JSON.parse(chunk.slice(6)) as {
        type: string; status?: string; text?: string; citations?: { ref: number }[];
      });
    const firstPartial = frames.findIndex((f) => f.type === "citations" && f.status === "partial");
    const laterProse = frames.findIndex((f) => f.type === "content_delta" && f.text?.includes("More prose"));
    expect(firstPartial).toBeGreaterThanOrEqual(0);
    expect(firstPartial).toBeLessThan(laterProse);
    expect(frames[firstPartial].citations?.map((c) => c.ref)).toEqual([1]);
  });

  it("tabular chat: table tags resolve from the cells read, and a stop keeps them", async () => {
    const tabularStore = {
      columns: [{ index: 4, name: "Break date" }],
      documents: [{ id: "row-a", filename: "Lease A.pdf" }],
      cells: new Map([["4:row-a", { summary: "31 March 2030" }]]),
    };
    const run = (stopAfterFirstTag: boolean) => {
      const p = { ...params(), tabularStore: tabularStore as never, citationSources: "tabular_cells" as const };
      streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
        callbacks?.onContentDelta?.("The break date is 31 March 2030 [[COL:0 ROW:0]]. ");
        if (stopAfterFirstTag) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        callbacks?.onContentDelta?.("An unread cell [[COL:0 ROW:9]].");
        return { fullText: "" };
      });
      return runLLMStream(p);
    };

    const done = await run(false);
    expect(done.events.flatMap((e) => (e.type === "content" ? [e.text] : [])).join("")).toBe(
      "The break date is 31 March 2030 [1]. An unread cell.",
    );
    expect(done.citations).toEqual([
      expect.objectContaining({ type: "tabular_citation", ref: 1, col_index: 0, row_index: 0, quote: "31 March 2030" }),
    ]);

    const stopped = await run(true).catch((error: { citations?: unknown[] }) => error);
    expect((stopped as { citations?: unknown[] }).citations).toEqual([
      expect.objectContaining({ type: "tabular_citation", ref: 1 }),
    ]);
  });
});

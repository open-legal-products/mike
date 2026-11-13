import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StreamParams = {
  runTools: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<unknown>;
};
const {
  streamChatWithTools,
  runEditDocument,
  planConnectorToolCall,
  executeMcpToolCall,
  reviewWithPlaybook,
  downloadFile,
  uploadFile,
  loadActiveVersion,
} = vi.hoisted(() => ({
  streamChatWithTools:
    vi.fn<(...args: [StreamParams]) => Promise<{ fullText: string }>>(),
  runEditDocument: vi.fn(),
  planConnectorToolCall: vi.fn(),
  executeMcpToolCall: vi.fn(),
  reviewWithPlaybook: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  loadActiveVersion: vi.fn(),
}));
vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../lib/llm/models",
  )),
  streamChatWithTools,
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
  executeMcpToolCall,
}));
vi.mock("../tools/documentOps", async (original) => ({
  ...(await original<typeof import("../tools/documentOps")>()),
  runEditDocument,
}));
vi.mock("../tools/connectorApprovals", async (original) => ({
  ...(await original<typeof import("../tools/connectorApprovals")>()),
  planConnectorToolCall,
}));
vi.mock("../../../playbooks/playbooks.service", async (original) => ({
  ...(await original<typeof import("../../../playbooks/playbooks.service")>()),
  reviewWithPlaybook,
}));
vi.mock("../../../../lib/storage", async (original) => ({
  ...(await original<typeof import("../../../../lib/storage")>()),
  downloadFile,
  downloadFileIfAvailable: vi.fn(async () => null),
  uploadFile,
}));
vi.mock("../../../../lib/documentVersions", async (original) => ({
  ...(await original<typeof import("../../../../lib/documentVersions")>()),
  loadActiveVersion,
}));

import {
  AssistantStreamAbortError,
  AssistantStreamError,
  isAbortError,
  runLLMStream,
} from "../streaming";
import { createKeyedLock } from "../tools/documentLocks";
import { emptyToolCallBatchResult } from "../tools/toolBatchResult";
import { runToolCalls } from "../tools/toolDispatcher";

const cardCall = (id: string) => ({
  id,
  name: "create_text_card",
  input: { title: `Card ${id}`, text: "Body" },
});

const framesOfType = (write: ReturnType<typeof vi.fn>, type: string) =>
  write.mock.calls
    .map(([frame]) => String(frame))
    .filter((frame) => frame.includes(`"type":"${type}"`));

const lease = () => ({
  docStore: new Map([
    ["doc-0", { filename: "Lease.docx", file_type: "docx", storage_path: "lease" }],
  ]) as never,
  docIndex: {
    "doc-0": { document_id: "d1", version_id: "v1", version_number: 1 },
  } as never,
});

const editedVersion = {
  ok: true,
  version_id: "v2",
  version_number: 2,
  storage_path: "lease-v2",
  download_url: "",
  annotations: [],
  errors: [],
};

/** One call of `name`, run with the given signal and the answer's shared locks. */
function runOne(
  name: string,
  args: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    documentLocks?: ReturnType<typeof createKeyedLock>;
    model?: string;
  },
  write = vi.fn(),
) {
  const { docStore, docIndex } = lease();
  return runToolCalls(
    [{ id: "call-1", function: { name, arguments: JSON.stringify(args) } }],
    docStore,
    "user-1",
    {} as never,
    write,
    undefined,
    undefined,
    docIndex,
    new Map(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a stopped turn's tool batch", () => {
  it("starts no further tools once the turn's signal has fired", async () => {
    const controller = new AbortController();
    // The first tool's output is the moment a deadline or Stop lands.
    const write = vi.fn((frame: string) => {
      if (frame.includes('"type":"text_card"')) controller.abort();
    });

    const result = await runToolCalls(
      ["a", "b", "c"].map((id) => ({
        id,
        function: {
          name: "create_text_card",
          arguments: JSON.stringify(cardCall(id).input),
        },
      })),
      new Map(),
      "user-1",
      {} as never,
      write,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { signal: controller.signal },
    );

    expect(framesOfType(write, "text_card")).toHaveLength(1);
    expect(result.textCardEvents.map((event) => event.card_id)).toEqual(["a"]);
  });

  it("is wired to the answer's signal, so the stream ends as stopped", async () => {
    const controller = new AbortController();
    const write = vi.fn((frame: string) => {
      if (frame.includes('"type":"text_card"')) controller.abort();
    });
    streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      await runTools([cardCall("a"), cardCall("b")]);
      return { fullText: "" };
    });

    const outcome = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Draft two cards." }],
      docStore: new Map(),
      docIndex: {},
      userId: "user-1",
      db: {} as never,
      write,
      includeAskInputs: false,
      allowDocumentMutation: false,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(isAbortError(outcome)).toBe(true);
    expect(framesOfType(write, "text_card")).toHaveLength(1);
  });

  it("keeps the event of an edit that finished as the turn stopped", async () => {
    const controller = new AbortController();
    // The edit saves its version; the deadline lands before the batch returns.
    runEditDocument.mockImplementationOnce(async () => {
      controller.abort();
      return editedVersion;
    });
    streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      await runTools([
        {
          id: "edit-1",
          name: "edit_document",
          input: { doc_id: "doc-0", edits: [{ find: "a", replace: "b" }] },
        },
      ]);
      return { fullText: "" };
    });

    const outcome = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Edit the lease." }],
      ...lease(),
      userId: "user-1",
      db: {} as never,
      write: vi.fn(),
      includeAskInputs: false,
      allowDocumentMutation: true,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(AssistantStreamAbortError);
    expect((outcome as AssistantStreamAbortError).events).toContainEqual(
      expect.objectContaining({
        type: "doc_edited",
        document_id: "d1",
        version_id: "v2",
      }),
    );
  });
});

describe("a batch where a later call rejects", () => {
  const editThenConnector = () =>
    streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      await runTools([
        {
          id: "edit-1",
          name: "edit_document",
          input: { doc_id: "doc-0", edits: [{ find: "a", replace: "b" }] },
        },
        { id: "mcp-1", name: "mcp_crm_update_record", input: { id: "r1" } },
      ]);
      return { fullText: "" };
    });

  const run = (signal?: AbortSignal) =>
    runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Edit the lease, then log it." }],
      ...lease(),
      userId: "user-1",
      db: {} as never,
      write: vi.fn(),
      includeAskInputs: false,
      allowDocumentMutation: true,
      ...(signal ? { signal } : {}),
    }).then(
      () => null,
      (error: unknown) => error,
    );

  const editEvents = (outcome: unknown) =>
    (outcome as AssistantStreamError).events.filter(
      (event) => event.type === "doc_edited",
    );

  it("keeps the edit that saved a version in the failed turn", async () => {
    runEditDocument.mockResolvedValueOnce(editedVersion);
    planConnectorToolCall.mockRejectedValueOnce(new Error("connector planning failed"));
    editThenConnector();

    const outcome = await run();

    expect(outcome).toBeInstanceOf(AssistantStreamError);
    expect(isAbortError(outcome)).toBe(false);
    expect(editEvents(outcome)).toEqual([
      expect.objectContaining({ document_id: "d1", version_id: "v2" }),
    ]);
  });

  it("keeps the edit, and ends the turn as stopped, when the rejection comes after a stop", async () => {
    const controller = new AbortController();
    runEditDocument.mockResolvedValueOnce(editedVersion);
    // The turn is stopped while the connector's plan is pending, and the plan
    // then rejects.
    planConnectorToolCall.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("connector planning failed");
    });
    editThenConnector();

    const outcome = await run(controller.signal);

    expect(outcome).toBeInstanceOf(AssistantStreamAbortError);
    expect(editEvents(outcome)).toEqual([
      expect.objectContaining({ document_id: "d1", version_id: "v2" }),
    ]);
  });
});

describe("grouped case searches before a rejecting call", () => {
  it("keeps the searches that finished in the batch result, once", async () => {
    planConnectorToolCall.mockRejectedValueOnce(new Error("connector planning failed"));
    const results = emptyToolCallBatchResult();
    const { docStore, docIndex } = lease();
    const outcome = await runToolCalls(
      [
        { id: "find-1", function: { name: "courtlistener_find_in_case", arguments: JSON.stringify({ cluster_id: 1, query: "damages" }) } },
        { id: "find-2", function: { name: "courtlistener_find_in_case", arguments: JSON.stringify({ cluster_id: 2, query: "damages" }) } },
        { id: "mcp-1", function: { name: "mcp_crm_update_record", arguments: JSON.stringify({ id: "r1" }) } },
      ],
      docStore,
      "user-1",
      {} as never,
      vi.fn(),
      undefined,
      undefined,
      docIndex,
      new Map(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { results },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(Error);
    const groups = results.courtlistenerEvents.filter(
      (event) => event.type === "courtlistener_find_in_case",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ cluster_id: null });
    expect((groups[0] as { searches?: unknown[] }).searches).toHaveLength(2);
  });
});

describe("a client tool that fails as the turn stops", () => {
  it("ends the turn as stopped, not as failed", async () => {
    const controller = new AbortController();
    streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      await runTools([{ id: "client-1", name: "word_read_selection", input: {} }]);
      return { fullText: "" };
    });

    const outcome = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Read my selection." }],
      ...lease(),
      userId: "user-1",
      db: {} as never,
      write: vi.fn(),
      includeAskInputs: false,
      clientTools: {
        schemas: [],
        owns: (name) => name === "word_read_selection",
        // The pane stops the turn, then its pending call fails plainly.
        execute: async () => {
          controller.abort();
          throw new Error("the task pane went away");
        },
      },
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(AssistantStreamAbortError);
  });
});

describe("a write that waited past the turn's stop", () => {
  const STOP_AT = 30_000;
  const WAIT = 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The deadline fires at STOP_AT while the call is still waiting. */
  function stopDuringWait() {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), STOP_AT);
    return controller.signal;
  }

  const afterWait = <T>(value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), WAIT));

  it("does not start an edit whose document lock frees after the stop", async () => {
    const documentLocks = createKeyedLock();
    // Another call of the same answer (a subagent's edit) holds the document.
    const release = await documentLocks.acquire("d1");
    setTimeout(release, WAIT);
    runEditDocument.mockResolvedValue(editedVersion);
    const write = vi.fn();

    const pending = runOne(
      "edit_document",
      { doc_id: "doc-0", edits: [{ find: "a", replace: "b" }] },
      { signal: stopDuringWait(), documentLocks },
      write,
    );
    await vi.advanceTimersByTimeAsync(WAIT);
    const result = await pending;

    expect(runEditDocument).not.toHaveBeenCalled();
    expect(result.docsEdited).toEqual([]);
    // No "Editing" card is opened for an edit that never ran.
    expect(framesOfType(write, "doc_edited_start")).toEqual([]);
  });

  it("stops an edit waiting behind a lock that is held past the stop", async () => {
    const documentLocks = createKeyedLock();
    // The holder keeps the document for the whole test.
    const release = await documentLocks.acquire("d1");
    let settled = false;

    const pending = runOne(
      "edit_document",
      { doc_id: "doc-0", edits: [{ find: "a", replace: "b" }] },
      { signal: stopDuringWait(), documentLocks },
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(STOP_AT);

    expect(settled).toBe(true);
    expect((await pending).docsEdited).toEqual([]);
    expect(runEditDocument).not.toHaveBeenCalled();
    release();
  });

  it("does not start a playbook review whose document lock frees after the stop", async () => {
    const documentLocks = createKeyedLock();
    const release = await documentLocks.acquire("d1");
    setTimeout(release, WAIT);

    const pending = runOne(
      "run_playbook",
      { doc_id: "doc-0", playbook_id: "playbook-1" },
      { signal: stopDuringWait(), documentLocks, model: "gemini-3.8-flash" },
    );
    await vi.advanceTimersByTimeAsync(WAIT);
    await pending;

    expect(reviewWithPlaybook).not.toHaveBeenCalled();
  });

  it("stops a playbook review that is running when the turn stops", async () => {
    // The review ends with the signal it is given, as its model call does,
    // or else fails on its own once the wait is over.
    reviewWithPlaybook.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
          setTimeout(() => reject(new Error("provider down")), WAIT);
        }),
    );
    const signal = stopDuringWait();

    const pending = runOne(
      "run_playbook",
      { doc_id: "doc-0", playbook_id: "playbook-1" },
      { signal, model: "gemini-3.8-flash" },
    );
    await vi.advanceTimersByTimeAsync(WAIT);
    const result = await pending;

    expect(reviewWithPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({ signal }),
    );
    // Ended by the stop, so it is not reported back as a failed review.
    expect(result.toolResults).toEqual([]);
  });

  it("does not run a connector call whose planning finishes after the stop", async () => {
    planConnectorToolCall.mockImplementation(() => afterWait({ type: "run" }));
    const write = vi.fn();

    const pending = runOne(
      "mcp_crm_update_record",
      { id: "r1" },
      { signal: stopDuringWait() },
      write,
    );
    await vi.advanceTimersByTimeAsync(WAIT);
    await pending;

    expect(planConnectorToolCall).toHaveBeenCalledTimes(1);
    expect(executeMcpToolCall).not.toHaveBeenCalled();
    expect(framesOfType(write, "mcp_tool_start")).toEqual([]);
  });

  it("does not upload copies whose source download finishes after the stop", async () => {
    loadActiveVersion.mockResolvedValue({
      storage_path: "lease",
      pdf_storage_path: null,
    });
    downloadFile.mockImplementation(() => afterWait(new ArrayBuffer(8)));
    // Deferred conversion keeps LibreOffice out of the path under test.
    vi.stubEnv("ASYNC_DOCUMENT_CONVERSION", "true");
    const pending = runOne(
      "replicate_document",
      { doc_id: "doc-0", new_filename: "Lease copy.docx" },
      { signal: stopDuringWait() },
    );
    await vi.advanceTimersByTimeAsync(WAIT);
    const result = await pending;
    vi.unstubAllEnvs();

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(result.docsReplicated).toEqual([]);
  });
});

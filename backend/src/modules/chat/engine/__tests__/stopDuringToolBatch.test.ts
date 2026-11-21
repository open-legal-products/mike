/**
 * A turn stopped while a later call of its tool batch is still pending.
 *
 * These run the real AI SDK adapter (streamAiSdk over a scripted model), not a
 * stand-in that awaits `runTools`: on a Stop or a deadline the adapter ends the
 * model stream at once, without waiting for the batch, and that early end is
 * what lost the completed edit from the stored turn (#827).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { streamChatWithTools, runEditDocument, planConnectorToolCall } =
  vi.hoisted(() => ({
    streamChatWithTools: vi.fn(),
    runEditDocument: vi.fn(),
    planConnectorToolCall: vi.fn(),
  }));
vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../lib/llm/models",
  )),
  streamChatWithTools,
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
  executeMcpToolCall: vi.fn(),
}));
vi.mock("../tools/documentOps", async (original) => ({
  ...(await original<typeof import("../tools/documentOps")>()),
  runEditDocument,
}));
vi.mock("../tools/connectorApprovals", async (original) => ({
  ...(await original<typeof import("../tools/connectorApprovals")>()),
  planConnectorToolCall,
}));

import { streamAiSdk } from "../../../../lib/llm/aiSdk";
import {
  config,
  makeModel,
  step,
  text,
  toolCall,
  finish,
} from "../../../../lib/llm/__tests__/mockLanguageModel";
import { startStreamRun } from "../../../../lib/streamRuns";
import { AssistantStreamAbortError, runLLMStream } from "../streaming";

const CONNECTOR_TOOL = {
  type: "function",
  function: {
    name: "mcp_crm_update_record",
    description: "Log a change in the CRM.",
    parameters: { type: "object", properties: {} },
  },
};

const editedVersion = {
  ok: true,
  version_id: "v2",
  version_number: 2,
  storage_path: "lease-v2",
  download_url: "",
  annotations: [],
  errors: [],
};

/** The model edits the lease and logs it, in one step. */
async function editThenLogModel() {
  const model = await makeModel([
    step(
      ...text("Updating the lease and logging it."),
      toolCall("edit-1", "edit_document", {
        doc_id: "doc-0",
        edits: [{ find: "thirty", replace: "fourteen" }],
      }),
      toolCall("mcp-1", "mcp_crm_update_record", {}),
      finish("tool-calls"),
    ),
  ]);
  streamChatWithTools.mockImplementation((params) =>
    streamAiSdk(params, config(model)),
  );
}

const run = (signal: AbortSignal, write: (s: string) => void = () => {}) =>
  runLLMStream({
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "user", content: "Edit the lease, then log it." }],
    docStore: new Map([
      [
        "doc-0",
        { filename: "Lease.docx", file_type: "docx", storage_path: "lease" },
      ],
    ]) as never,
    docIndex: {
      "doc-0": { document_id: "d1", version_id: "v1", version_number: 1 },
    } as never,
    userId: "user-1",
    db: {} as never,
    write,
    extraTools: [CONNECTOR_TOOL],
    includeAskInputs: false,
    allowDocumentMutation: true,
    signal,
  });

const editEvents = (events: { type: string }[]) =>
  events.filter((event) => event.type === "doc_edited");

/** The connector's planning hangs until the test settles it. */
function pendingConnectorPlan() {
  let reject!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  planConnectorToolCall.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
        markStarted();
      }),
  );
  return { started, reject: (error: Error) => reject(error) };
}

beforeEach(() => {
  vi.clearAllMocks();
  runEditDocument.mockResolvedValue(editedVersion);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("a turn stopped while a later call of its batch is pending", () => {
  it("keeps the edit that finished before Stop in the stopped turn, once", async () => {
    await editThenLogModel();
    const plan = pendingConnectorPlan();
    const controller = new AbortController();

    const outcome = run(controller.signal).catch((error: unknown) => error);
    await plan.started;
    controller.abort();
    const stopped = await outcome;
    // The pending call settling later changes nothing that was stored.
    plan.reject(new Error("connector planning failed"));

    expect(stopped).toBeInstanceOf(AssistantStreamAbortError);
    expect(editEvents((stopped as AssistantStreamAbortError).events)).toEqual([
      expect.objectContaining({ document_id: "d1", version_id: "v2" }),
    ]);
  });

  it("keeps it when the idle deadline ends the turn", async () => {
    const IDLE_MS = 30_000;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubEnv("STREAM_IDLE_TIMEOUT_MS", String(IDLE_MS));
    const stream = startStreamRun({
      id: "run-827",
      key: "chat-827",
      userId: "user-1",
      forcedStopFrames: [],
    });
    if (!stream) throw new Error("run not started");
    await editThenLogModel();
    const plan = pendingConnectorPlan();

    const outcome = run(stream.signal, stream.write).catch(
      (error: unknown) => error,
    );
    await plan.started;
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    const stopped = await outcome;
    stream.finish();

    expect(stream.stopReason).toBe("idle");
    expect(stopped).toBeInstanceOf(AssistantStreamAbortError);
    expect(editEvents((stopped as AssistantStreamAbortError).events)).toEqual([
      expect.objectContaining({ document_id: "d1", version_id: "v2" }),
    ]);
  });
});

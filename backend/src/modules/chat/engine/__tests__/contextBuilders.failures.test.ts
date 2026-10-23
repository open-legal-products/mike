import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../../__tests__/helpers/scriptedDb";

// The database failures these helpers swallow (a caller falls back or returns
// null) used to be logged as bare PostgREST objects: no stack, no code in
// Sentry. Each is now reported once, wrapped in the kind that names it, with
// the database's own error as the cause, before the same object is logged.

const { reportError, ensureDefaultWorkflows } = vi.hoisted(() => ({
  reportError: vi.fn(() => null),
  ensureDefaultWorkflows: vi.fn(async () => {}),
}));
vi.mock("../../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportError,
}));
vi.mock("../../../../lib/workflowCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/workflowCatalog")>()),
  ensureDefaultWorkflows,
}));

import {
  appendAssistantEventsToMessage,
  buildWorkflowStore,
  loadAssistantMessage,
} from "../contextBuilders";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  ensureDefaultWorkflows.mockResolvedValue(undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadAssistantMessage", () => {
  it("reports a failed select as a context failure and returns null", async () => {
    const dbError = { code: "PGRST116", message: "JSON object requested" };
    const fake = scriptedDb([{ table: "chat_messages", error: dbError }]);

    await expect(loadAssistantMessage(fake.db, "chat-1", "message-1")).resolves.toBeNull();

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "chat.context_failed", cause: dbError }),
      { level: "warning", tags: { component: "chat-stream" } },
    );
    const [reported] = reportError.mock.calls[0] as unknown[];
    expect(errorSpy).toHaveBeenCalledWith(
      "[assistant-events] failed to load assistant message",
      reported,
    );
    fake.done();
  });
});

describe("appendAssistantEventsToMessage", () => {
  it("reports a failed append RPC as a save failure with the RPC's error as cause", async () => {
    const dbError = { code: "P0001", message: "message belongs to another author" };
    const fake = scriptedDb([{ rpc: "append_chat_assistant_events", error: dbError }]);

    await expect(
      appendAssistantEventsToMessage(
        fake.db,
        "chat-1",
        "message-1",
        "user-1",
        [{ type: "error", message: "x" }],
        undefined,
      ),
    ).resolves.toBe(false);

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "chat.message_save_failed", cause: dbError }),
      { tags: { component: "chat-stream" } },
    );
    fake.done();
  });

  it("reports an append the RPC declined as a save failure too", async () => {
    const fake = scriptedDb([{ rpc: "append_chat_assistant_events", data: "not_found" }]);

    await expect(
      appendAssistantEventsToMessage(
        fake.db,
        "chat-1",
        "message-1",
        "user-1",
        [{ type: "error", message: "x" }],
        undefined,
      ),
    ).resolves.toBe(false);

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "chat.message_save_failed",
        cause: { result: "not_found" },
      }),
      { tags: { component: "chat-stream" } },
    );
    fake.done();
  });
});

describe("buildWorkflowStore", () => {
  it("reports a failed default install as a warning and still builds the store", async () => {
    const installError = new Error("insert failed");
    ensureDefaultWorkflows.mockRejectedValueOnce(installError);
    const fake = scriptedDb([
      { table: "organizations", data: { kind: "team" } },
      { table: "mike_workflows", data: [] },
      { rpc: "get_workflows_overview", data: [] },
    ]);

    const store = await buildWorkflowStore("u", "u@example.com", fake.db, "firm");

    expect(store.size).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "workflows.default_install_failed", cause: installError }),
      { level: "warning", tags: { component: "chat-stream" } },
    );
    fake.done();
  });

  it("reports a failed catalog lookup as a context failure and keeps going", async () => {
    const dbError = { code: "42P01", message: "relation does not exist" };
    const fake = scriptedDb([
      { table: "organizations", data: { kind: "team" } },
      { table: "mike_workflows", error: dbError },
      { rpc: "get_workflows_overview", data: [] },
    ]);

    const store = await buildWorkflowStore("u", "u@example.com", fake.db, "firm");

    expect(store.size).toBe(0);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "chat.context_failed", cause: dbError }),
      { level: "warning", tags: { component: "chat-stream" } },
    );
    fake.done();
  });
});

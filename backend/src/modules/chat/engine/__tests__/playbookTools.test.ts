import { beforeEach, expect, it, vi } from "vitest";
import type { Db } from "../../../../lib/supabase";

const playbooks = vi.hoisted(() => ({
  listPlaybooks: vi.fn(),
  reviewWithPlaybook: vi.fn(),
}));
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(() => null) }));
vi.mock("../../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reportError,
}));
vi.mock("../../../playbooks/playbooks.service", async (original) => ({
  ...(await original<typeof import("../../../playbooks/playbooks.service")>()),
  ...playbooks,
}));

import { runToolCalls } from "../tools/toolDispatcher";

const db = {} as Db;
const annotation = {
  kind: "edit" as const,
  edit_id: "e1",
  document_id: "d1",
  version_id: "v2",
  version_number: 2,
  change_id: "c1",
  deleted_text: "unlimited",
  inserted_text: "capped",
  context_before: "",
  context_after: "",
  status: "pending" as const,
};

function call(name: string, args: Record<string, unknown> = {}) {
  return { id: name, function: { name, arguments: JSON.stringify(args) } };
}

function attachments() {
  const docStore = new Map([
    ["doc-0", { filename: "Supply.docx", file_type: "docx" }],
  ]) as never;
  const docIndex = {
    "doc-0": { document_id: "d1", version_id: "v1", version_number: 1 },
  } as never;
  return { docStore, docIndex };
}

function dispatch(
  calls: Parameters<typeof runToolCalls>[0],
  write = vi.fn(),
  model: string | null = "claude-opus-5",
) {
  const { docStore, docIndex } = attachments();
  return runToolCalls(
    calls,
    docStore,
    "u1",
    db,
    write,
    undefined,
    undefined,
    docIndex,
    new Map() as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { userEmail: "u1@example.com", model: model ?? undefined },
  );
}

beforeEach(() => vi.clearAllMocks());

it("lists the playbooks the user can run in this workspace", async () => {
  playbooks.listPlaybooks.mockResolvedValue([
    {
      id: "pb-1",
      name: "NDA",
      description: "Mutual NDAs",
      content: { documentTypes: ["NDA"], representedParty: "Recipient" },
    },
  ]);

  const result = await dispatch([call("list_playbooks")]);

  expect(playbooks.listPlaybooks).toHaveBeenCalledWith("u1", db, {
    workspace: "personal",
    email: "u1@example.com",
  });
  expect(
    JSON.parse((result.toolResults[0] as { content: string }).content),
  ).toEqual([
    {
      id: "pb-1",
      name: "NDA",
      description: "Mutual NDAs",
      document_types: ["NDA"],
      represented_party: "Recipient",
    },
  ]);
});

it("runs a playbook on an attached Word document and shows its tracked changes as edit cards", async () => {
  playbooks.reviewWithPlaybook.mockResolvedValue({
    id: "run-1",
    summary: "One issue.",
    editedVersionId: "v2",
    editedVersionNumber: 2,
    editedDownloadUrl: "/download/v2",
    findings: [
      {
        ruleName: "Liability cap",
        status: "unacceptable",
        location: "Clause 9",
        analysis: "Uncapped.",
        quote: "unlimited",
        suggestedText: "capped",
        edit: annotation,
      },
    ],
  });
  const write = vi.fn();

  const result = await dispatch(
    [call("run_playbook", { playbook_id: "pb-1", doc_id: "doc-0" })],
    write,
  );

  expect(playbooks.reviewWithPlaybook).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: "u1",
      playbookId: "pb-1",
      documentId: "d1",
      // A Word document is read from its file by the review.
      documentText: undefined,
      model: "claude-opus-5",
      reviewMode: "strict",
    }),
  );
  expect(result.docsEdited).toEqual([
    expect.objectContaining({
      document_id: "d1",
      version_id: "v2",
      version_number: 2,
      annotations: [annotation],
    }),
  ]);
  expect(write).toHaveBeenCalledWith(
    expect.stringContaining('"type":"doc_edited"'),
  );
  const content = JSON.parse(
    (result.toolResults[0] as { content: string }).content,
  );
  expect(content).toMatchObject({
    run_id: "run-1",
    tracked_changes: 1,
    findings: [{ rule: "Liability cap", has_tracked_change: true }],
  });
});

it("reviews the open Word document from its request text, without saving a version", async () => {
  playbooks.reviewWithPlaybook.mockResolvedValue({
    id: "run-2",
    summary: "One issue.",
    editedVersionId: null,
    editedVersionNumber: null,
    findings: [
      {
        ruleName: "Liability cap",
        status: "unacceptable",
        location: "Clause 9",
        analysis: "Uncapped.",
        quote: "unlimited",
        suggestedText: "capped",
        edit: null,
      },
    ],
  });
  // What the Word route puts in the store for the pane's live document:
  // inline text, and no docIndex entry because there is no stored row.
  const docStore = new Map([
    [
      "active-word-document",
      {
        filename: "Contract.docx",
        file_type: "text/markdown",
        storage_path: "inline:word-document:w1",
        inline_text: "Liability is unlimited.",
      },
    ],
  ]) as never;
  const write = vi.fn();

  const result = await runToolCalls(
    [
      call("run_playbook", {
        playbook_id: "pb-1",
        doc_id: "active-word-document",
      }),
    ],
    docStore,
    "u1",
    db,
    write,
    undefined,
    undefined,
    {} as never,
    new Map() as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { userEmail: "u1@example.com", model: "claude-opus-5" },
  );

  expect(playbooks.reviewWithPlaybook).toHaveBeenCalledWith(
    expect.objectContaining({
      playbookId: "pb-1",
      documentId: undefined,
      documentText: "Liability is unlimited.",
      documentName: "Contract.docx",
    }),
  );
  expect(result.docsEdited).toEqual([]);
  const content = JSON.parse(
    (result.toolResults[0] as { content: string }).content,
  );
  expect(content).toMatchObject({ run_id: "run-2", tracked_changes: 0 });
  expect(content.next_required_action).toMatch(/open Word document/);
});

it("refuses a document that is not attached, and a turn without a model", async () => {
  const missing = await dispatch([
    call("run_playbook", { playbook_id: "pb-1", doc_id: "doc-9" }),
  ]);
  expect(
    JSON.parse((missing.toolResults[0] as { content: string }).content).error,
  ).toMatch(/not found/i);

  const noModel = await dispatch(
    [call("run_playbook", { playbook_id: "pb-1", doc_id: "doc-0" })],
    vi.fn(),
    null,
  );
  expect(
    JSON.parse((noModel.toolResults[0] as { content: string }).content).error,
  ).toMatch(/model/i);
  expect(playbooks.reviewWithPlaybook).not.toHaveBeenCalled();
});

it("reports a tool that failed under chat.tool_failed, with the cause and no tool name in the tags", async () => {
  const cause = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  playbooks.listPlaybooks.mockRejectedValue(cause);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await dispatch([call("list_playbooks")]);

  expect((result.toolResults[0] as { content: string }).content).not.toContain(
    "relation does not exist",
  );
  expect(reportError).toHaveBeenCalledTimes(1);
  expect(reportError).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "chat.tool_failed", cause }),
    { tags: { component: "chat-stream", operation: "chat.tool" } },
  );
  // The report is the Sentry event; the log keeps its redacted category.
  expect(warnSpy).toHaveBeenCalledWith("[run_tools] list_playbooks failed", expect.anything());
  expect(errorSpy).not.toHaveBeenCalled();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

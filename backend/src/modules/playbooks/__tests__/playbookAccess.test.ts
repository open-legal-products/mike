import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
const { completeText, getUserApiKeys } = vi.hoisted(() => ({
  completeText: vi.fn(),
  getUserApiKeys: vi.fn(),
}));
vi.mock("../../../lib/llm", async (original) => ({
  ...(await original<typeof import("../../../lib/llm")>()),
  completeText,
}));
vi.mock("../../user/user.service", () => ({ getUserApiKeys }));
const docs = vi.hoisted(() => ({
  applyTrackedEditsToDocument: vi.fn(),
  loadCurrentVersionBytes: vi.fn(),
  loadActiveVersion: vi.fn(),
  extractDocxBodyText: vi.fn(),
}));
vi.mock("../../documents/documents.service", async (original) => ({
  ...(await original<typeof import("../../documents/documents.service")>()),
  applyTrackedEditsToDocument: docs.applyTrackedEditsToDocument,
  loadCurrentVersionBytes: docs.loadCurrentVersionBytes,
}));
vi.mock("../../../lib/documentVersions", async (original) => ({
  ...(await original<typeof import("../../../lib/documentVersions")>()),
  loadActiveVersion: docs.loadActiveVersion,
}));
vi.mock("../../../lib/docxTrackedChanges", async (original) => ({
  ...(await original<typeof import("../../../lib/docxTrackedChanges")>()),
  extractDocxBodyText: docs.extractDocxBodyText,
}));
import {
  blankPlaybookContent,
  createPlaybook,
  getPlaybook,
  INTERRUPTED_RUN_ERROR,
  deletePlaybookRun,
  listAllPlaybookRuns,
  listPlaybookRunHistory,
  listPlaybookRuns,
  listPlaybooks,
  playbookRunStatuses,
  reviewWithPlaybook,
  startPlaybookReview,
  updatePlaybookContent,
  deletePlaybook,
} from "../playbooks.operations";
import {
  listPlaybookPeople,
  revokePlaybookShare,
  sharePlaybook,
} from "../playbooks.sharing";
import { database, ORG, OTHER, type Row } from "./playbookTestDb";
function book(overrides: Row = {}): Row {
  return {
    id: "book",
    user_id: "owner",
    org_id: null,
    visibility: "private",
    shared_with: [],
    name: "Guide",
    description: "",
    content_json: blankPlaybookContent("Guide"),
    created_at: "2026-10-17",
    updated_at: "2026-10-17",
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  getUserApiKeys.mockResolvedValue({ claude: "test-key" });
  completeText.mockResolvedValue(
    JSON.stringify({ summary: "Reviewed", findings: [] }),
  );
});
describe("playbook access and autosave", () => {
  it("allows a named personal recipient to read, without exposing the recipient list", async () => {
    const { db } = database([
      book({ shared_with: ["reader@example.com", "private@example.com"] }),
    ]);
    expect(
      await getPlaybook("reader", "book", db, "Reader@example.com"),
    ).toMatchObject({ canEdit: false, sharedWith: [] });
    await expect(
      getPlaybook("stranger", "book", db, "stranger@example.com"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updatePlaybookContent(
        "reader",
        "book",
        blankPlaybookContent("Changed"),
        db,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("requires current org membership even for the creator, and keeps private books private", async () => {
    const { db } = database(
      [book({ org_id: ORG, visibility: "organization" })],
      [{ user_id: "member", org_id: ORG, role: "member" }],
    );
    expect(await getPlaybook("member", "book", db)).toMatchObject({
      canEdit: false,
    });
    await expect(getPlaybook("owner", "book", db)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      updatePlaybookContent(
        "member",
        "book",
        blankPlaybookContent("Changed"),
        db,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const privateDb = database(
      [book({ org_id: ORG })],
      [{ user_id: "admin", org_id: ORG, role: "owner" }],
    ).db;
    await expect(getPlaybook("admin", "book", privateDb)).rejects.toMatchObject(
      { status: 404 },
    );
  });
  it("lists only accessible books in the selected workspace", async () => {
    const { db } = database(
      [
        book({ id: "mine" }),
        book({
          id: "shared",
          user_id: "other",
          shared_with: ["owner@example.com"],
        }),
        book({
          id: "public",
          user_id: "other",
          org_id: ORG,
          visibility: "organization",
        }),
        book({ id: "private", user_id: "other", org_id: ORG }),
        book({ id: "left-org", org_id: OTHER }),
      ],
      [{ user_id: "owner", org_id: ORG, role: "member" }],
    );
    expect(
      (
        await listPlaybooks("owner", db, {
          workspace: "personal",
          email: "owner@example.com",
        })
      ).map((item) => item.id),
    ).toEqual(["mine", "shared"]);
    expect(
      (await listPlaybooks("owner", db, { workspace: ORG })).map(
        (item) => item.id,
      ),
    ).toEqual(["public"]);
    await expect(
      listPlaybooks("owner", db, { workspace: OTHER }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createPlaybook("owner", "Guide", db, OTHER),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("lists the caller's runs only from playbooks they can still open", async () => {
    const { db, tables } = database(
      [
        book({ id: "mine", name: "Mine" }),
        // Another person's private playbook: any earlier access is gone.
        book({ id: "revoked", user_id: "other", name: "Revoked" }),
        book({
          id: "public",
          user_id: "other",
          org_id: ORG,
          visibility: "organization",
          name: "Public",
        }),
      ],
      [{ user_id: "owner", org_id: ORG, role: "member" }],
    );
    const run = (id: string, playbookId: string, userId = "owner") => ({
      id,
      playbook_id: playbookId,
      user_id: userId,
      model: "claude-opus-5-5",
      document_name: `${id}.docx`,
      review_mode: "strict",
      status: "completed",
      summary: "",
      findings_json: [],
      content_json: blankPlaybookContent("Snapshot"),
      error: null,
      started_at: "2026-10-17T00:00:00.000Z",
      completed_at: null,
    });
    tables.playbook_runs.push(
      run("r-mine", "mine"),
      run("r-revoked", "revoked"),
      run("r-public", "public"),
      run("r-someone-else", "mine", "someone"),
    );

    const personal = await listAllPlaybookRuns("owner", db, {
      workspace: "personal",
      email: "owner@example.com",
    });
    expect(personal.map((item) => item.id)).toEqual(["r-mine"]);
    expect(personal[0]).toMatchObject({
      playbookId: "mine",
      playbookName: "Mine",
    });
    // The rules snapshot stays on the server.
    expect(personal[0]).not.toHaveProperty("content_json");
    expect(
      (await listAllPlaybookRuns("owner", db, { workspace: ORG })).map(
        (item) => item.id,
      ),
    ).toEqual(["r-public"]);
  });
  it("creates a playbook from its details and names its creator", async () => {
    const { db } = database(
      [],
      [],
      [
        {
          user_id: "owner",
          display_name: "Olive Owner",
          email: "owner@example.com",
          profile_photo: null,
        },
      ],
    );
    const created = await createPlaybook(
      "owner",
      {
        name: " NDA playbook ",
        description: "Mutual NDAs",
        representedParty: "Recipient",
        documentTypes: ["NDA"],
        jurisdictions: ["England and Wales"],
      },
      db,
    );
    expect(created.content).toMatchObject({
      name: "NDA playbook",
      description: "Mutual NDAs",
      representedParty: "Recipient",
      documentTypes: ["NDA"],
      jurisdictions: ["England and Wales"],
    });
    expect(created.creatorName).toBe("Olive Owner");
    expect((await listPlaybooks("owner", db))[0].creatorName).toBe(
      "Olive Owner",
    );
    await expect(
      createPlaybook("owner", { documentTypes: [" "] }, db),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("creates a playbook public to its organization, or private by default", async () => {
    const { db } = database(
      [],
      [{ user_id: "owner", org_id: ORG, role: "member" }],
    );
    const shared = await createPlaybook(
      "owner",
      { name: "Public guide" },
      db,
      ORG,
      "organization",
    );
    expect(shared).toMatchObject({ orgId: ORG, visibility: "organization" });
    expect(
      await createPlaybook("owner", { name: "Private guide" }, db, ORG),
    ).toMatchObject({ orgId: ORG, visibility: "private" });
    // A personal playbook has no organization to be opened to.
    await expect(
      createPlaybook("owner", { name: "Mine" }, db, "personal", "organization"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createPlaybook("owner", { name: "Odd" }, db, ORG, "everyone"),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("preserves unfinished content and refuses a public personal playbook", async () => {
    const { db, writes } = database([book()]);
    const content = {
      ...blankPlaybookContent("Guide"),
      name: "",
      topics: [{ id: "empty", name: "", rules: [] }],
    };
    const saved = await updatePlaybookContent("owner", "book", content, db);
    expect(saved.content).toEqual(content);
    expect(writes[0].payload).not.toHaveProperty("status");
    expect(writes[0].payload).not.toHaveProperty("shared_with");
    await expect(
      updatePlaybookContent("owner", "book", content, db, {
        visibility: "organization",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("rejects oversized fields without writing", async () => {
    const { db, writes } = database([book()]);
    await expect(
      updatePlaybookContent(
        "owner",
        "book",
        { name: "x".repeat(201), topics: [] },
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(writes).toHaveLength(0);
  });
  it("reviews current saved rules and retains the exact content on the run", async () => {
    const { db, writes } = database([
      book({ shared_with: ["reader@example.com"] }),
    ]);
    const result = await reviewWithPlaybook({
      userId: "reader",
      userEmail: "reader@example.com",
      playbookId: "book",
      documentText: "Contract",
      model: "claude-opus-5",
      reviewMode: "strict",
      db,
    });
    expect(result.status).toBe("completed");
    const run = writes.find(
      (write) => write.table === "playbook_runs" && write.op === "insert",
    );
    expect(run?.payload.content_json).toEqual(blankPlaybookContent("Guide"));
    expect(run?.payload).not.toHaveProperty("version_id");
    expect(result).not.toHaveProperty("versionNumber");
  });
  it("returns a run before the review finishes, and records how it ended", async () => {
    const { db, tables } = database([book()]);
    let answer!: (text: string) => void;
    completeText.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    );
    const { run, done } = await startPlaybookReview({
      userId: "owner",
      playbookId: "book",
      documentText: "Contract",
      documentName: "msa.txt",
      model: "claude-opus-5",
      reviewMode: "strict",
      db,
    });
    // The caller can leave now; the run is stored as running.
    expect(run).toMatchObject({ status: "running", documentName: "msa.txt" });
    expect(tables.playbook_runs[0]).toMatchObject({ status: "running" });

    answer(JSON.stringify({ summary: "Reviewed", findings: [] }));
    await expect(done).resolves.toMatchObject({ status: "completed" });
    expect(tables.playbook_runs[0]).toMatchObject({
      status: "completed",
      summary: "Reviewed",
    });
  });
  it("reports only issues when asked, and records the scope on the run", async () => {
    const content = {
      ...blankPlaybookContent("Guide"),
      rules: [
        { id: "cap", name: "Liability cap", concept: "A cap on liability." },
        { id: "law", name: "Governing law", concept: "The governing law." },
        { id: "term", name: "Term", concept: "How long it lasts." },
      ],
    };
    const { db, tables } = database([book({ content_json: content })]);
    const finding = (ruleId: string, status: string) => ({
      ruleId,
      ruleName: ruleId,
      status,
      quote: "",
      location: "",
      analysis: `${ruleId} is ${status}.`,
    });
    // A model may still report more than it was asked for.
    completeText.mockResolvedValueOnce(
      JSON.stringify({
        summary: "One issue.",
        findings: [finding("cap", "unacceptable"), finding("law", "acceptable")],
      }),
    );
    const result = await reviewWithPlaybook({
      userId: "owner",
      playbookId: "book",
      documentText: "Contract",
      model: "claude-opus-5",
      reviewMode: "strict",
      reviewScope: "issues",
      db,
    });

    expect(completeText.mock.lastCall?.[0].user).toContain(
      "REVIEW SCOPE: issues only",
    );
    // The acceptable finding is dropped, and the unreported rule ("term")
    // is not flagged as missing a result.
    expect(result.findings.map((item) => item.ruleId)).toEqual(["cap"]);
    expect(result.reviewScope).toBe("issues");
    expect(tables.playbook_runs[0]).toMatchObject({ review_scope: "issues" });
    expect(
      (await listPlaybookRuns("owner", "book", db))[0].reviewScope,
    ).toBe("issues");
  });
  it("defaults to a full review that flags every rule it did not report", async () => {
    const content = {
      ...blankPlaybookContent("Guide"),
      rules: [
        { id: "cap", name: "Liability cap", concept: "A cap on liability." },
        { id: "law", name: "Governing law", concept: "The governing law." },
      ],
    };
    const { db, tables } = database([book({ content_json: content })]);
    const result = await reviewWithPlaybook({
      userId: "owner",
      playbookId: "book",
      documentText: "Contract",
      model: "claude-opus-5",
      reviewMode: "strict",
      db,
    });
    expect(completeText.mock.lastCall?.[0].user).not.toContain("REVIEW SCOPE");
    expect(result.findings.map((item) => item.status)).toEqual([
      "needs_review",
      "needs_review",
    ]);
    expect(tables.playbook_runs[0]).toMatchObject({ review_scope: "full" });
  });
  it("records a failed review on its run", async () => {
    const { db, tables } = database([book()]);
    completeText.mockRejectedValueOnce(new Error("provider down"));
    const { done } = await startPlaybookReview({
      userId: "owner",
      playbookId: "book",
      documentText: "Contract",
      model: "claude-opus-5",
      reviewMode: "strict",
      db,
    });
    await expect(done).rejects.toThrow();
    expect(tables.playbook_runs[0]).toMatchObject({ status: "failed" });
    expect(tables.playbook_runs[0].completed_at).toBeTruthy();
  });
  it("reports a silent running review as interrupted only once no job will run it", async () => {
    const { db, tables } = database([book()]);
    const silent = new Date(Date.now() - 10 * 60_000).toISOString();
    const recent = new Date().toISOString();
    const stored = (id: string, updatedAt: string) => ({
      id,
      playbook_id: "book",
      user_id: "owner",
      model: "claude-opus-5",
      document_name: `${id}.docx`,
      review_mode: "strict",
      status: "running",
      summary: null,
      findings_json: [],
      content_json: blankPlaybookContent("Guide"),
      error: null,
      started_at: updatedAt,
      updated_at: updatedAt,
      completed_at: null,
    });
    tables.playbook_runs.push(
      stored("orphan", silent),
      stored("live", recent),
      // Silent because its worker died, but its job is still queued (or
      // claimed, awaiting the lease to expire), so it will run again.
      stored("queued", silent),
    );
    tables.db_jobs = [
      { dedupe_key: "playbook.review:queued", status: "pending" },
      // A finished job no longer speaks for its run.
      { dedupe_key: "playbook.review:orphan", status: "failed" },
    ];

    const runs = await listPlaybookRuns("owner", "book", db);
    expect(runs.find((run) => run.id === "queued")).toMatchObject({
      status: "running",
      error: null,
    });
    expect(runs.find((run) => run.id === "orphan")).toMatchObject({
      status: "failed",
      error: INTERRUPTED_RUN_ERROR,
    });
    expect(runs.find((run) => run.id === "live")).toMatchObject({
      status: "running",
      error: null,
    });
    expect(
      await playbookRunStatuses("owner", ["orphan", "live", "missing"], db),
    ).toEqual([
      { id: "orphan", status: "failed", completedAt: null },
      { id: "live", status: "running", completedAt: null },
    ]);
    // Only the caller's own runs are reported.
    expect(await playbookRunStatuses("someone", ["live"], db)).toEqual([]);
  });
  it("deletes the caller's finished run, but not a running one or another person's", async () => {
    const { db, tables } = database([book()]);
    const now = new Date().toISOString();
    const stored = (id: string, status: string, userId = "owner") => ({
      id,
      playbook_id: "book",
      user_id: userId,
      status,
      error: null,
      findings_json: [],
      content_json: blankPlaybookContent("Guide"),
      started_at: now,
      updated_at: now,
    });
    const silent = new Date(Date.now() - 10 * 60_000).toISOString();
    tables.playbook_runs.push(
      stored("done", "completed"),
      stored("busy", "running"),
      stored("theirs", "completed", "someone"),
      { ...stored("queued", "running"), started_at: silent, updated_at: silent },
    );
    tables.db_jobs = [{ dedupe_key: "playbook.review:queued", status: "running" }];

    await deletePlaybookRun("owner", "done", db);
    expect(tables.playbook_runs.map((run) => run.id)).toEqual([
      "busy",
      "theirs",
      "queued",
    ]);
    await expect(deletePlaybookRun("owner", "busy", db)).rejects.toMatchObject({
      status: 409,
    });
    // A job still holds it, so it will write to the run.
    await expect(deletePlaybookRun("owner", "queued", db)).rejects.toMatchObject({
      status: 409,
    });
    tables.db_jobs = [];
    await expect(deletePlaybookRun("owner", "theirs", db)).rejects.toMatchObject({
      status: 404,
    });
    expect(tables.playbook_runs.map((run) => run.id)).toEqual([
      "busy",
      "theirs",
      "queued",
    ]);
    // With its job gone it is interrupted, and can be deleted.
    await deletePlaybookRun("owner", "queued", db);
    expect(tables.playbook_runs.map((run) => run.id)).toEqual(["busy", "theirs"]);
  });
  it("pages the caller's runs for History, named after their playbooks", async () => {
    const { db, tables } = database([book()]);
    for (const [id, startedAt, userId] of [
      ["new", "2026-10-18T10:00:00.000Z", "owner"],
      ["old", "2026-10-17T10:00:00.000Z", "owner"],
      ["theirs", "2026-10-18T11:00:00.000Z", "someone"],
    ])
      tables.playbook_runs.push({
        id,
        playbook_id: "book",
        user_id: userId,
        document_name: `${id}.pdf`,
        status: "completed",
        error: null,
        findings_json: [{ heavy: true }],
        content_json: blankPlaybookContent("Guide"),
        started_at: startedAt,
        updated_at: startedAt,
        completed_at: startedAt,
      });

    const page = await listPlaybookRunHistory("owner", db);
    expect(page.map((run) => run.id)).toEqual(["new", "old"]);
    expect(page[0]).toEqual({
      id: "new",
      playbookId: "book",
      playbookName: "Guide",
      documentName: "new.pdf",
      status: "completed",
      error: null,
      startedAt: "2026-10-18T10:00:00.000Z",
      completedAt: "2026-10-18T10:00:00.000Z",
    });
    expect(
      (
        await listPlaybookRunHistory("owner", db, {
          before: "2026-10-18T10:00:00.000Z",
        })
      ).map((run) => run.id),
    ).toEqual(["old"]);
  });
  describe("reviewing a stored Word document", () => {
    const content = {
      ...blankPlaybookContent("Guide"),
      rules: [
        { id: "cap", name: "Liability cap", concept: "A cap on liability." },
        { id: "law", name: "Governing law", concept: "The governing law.", required: true },
      ],
    };
    const annotation = (id: string) => ({
      kind: "edit",
      edit_id: id,
      document_id: "doc-1",
      version_id: "v2",
      version_number: 2,
      change_id: `c-${id}`,
      deleted_text: "",
      inserted_text: "",
      context_before: "",
      context_after: "",
      status: "pending",
    });
    function setup(fileType: "docx" | "pdf" = "docx") {
      const fixture = database([book({ content_json: content })]);
      fixture.tables.documents = [
        { id: "doc-1", user_id: "owner", project_id: null, org_id: null, workflow_id: null },
      ];
      docs.loadActiveVersion.mockResolvedValue({
        id: "v1",
        storage_path: "documents/doc-1.docx",
        filename: fileType === "docx" ? "Supply.docx" : "Supply.pdf",
        file_type: fileType,
      });
      docs.loadCurrentVersionBytes.mockResolvedValue({
        bytes: Buffer.from("docx"),
        storage_path: "documents/doc-1.docx",
      });
      docs.extractDocxBodyText.mockResolvedValue(
        "Liability is unlimited.\nPayment is due in 30 days.",
      );
      completeText.mockResolvedValue(
        JSON.stringify({
          summary: "Two issues.",
          findings: [
            {
              ruleId: "cap",
              ruleName: "Liability cap",
              status: "unacceptable",
              quote: "Liability is unlimited.",
              analysis: "Uncapped.",
              suggestedText: "Liability is capped at fees paid.",
            },
            {
              ruleId: "law",
              ruleName: "Governing law",
              status: "missing_required",
              analysis: "No governing law.",
              suggestedText: "English law governs this agreement.",
              insertAfter: "Payment is due in 30 days.",
            },
          ],
        }),
      );
      return fixture;
    }
    const review = (db: Db, extra: Record<string, unknown> = {}) =>
      reviewWithPlaybook({
        userId: "owner",
        playbookId: "book",
        documentId: "doc-1",
        model: "claude-opus-5",
        reviewMode: "strict",
        db,
        ...extra,
      });

    it("applies suggested language as tracked changes tied to each finding", async () => {
      const { db, writes } = setup();
      docs.applyTrackedEditsToDocument.mockResolvedValue({
        ok: true,
        version_id: "v2",
        version_number: 2,
        storage_path: "edited.docx",
        download_url: "/download",
        annotations: [annotation("e1"), annotation("e2")],
        errors: [],
      });

      const result = await review(db);

      expect(docs.applyTrackedEditsToDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "doc-1",
          expectedVersion: { id: "v1", storagePath: "documents/doc-1.docx" },
          edits: [
            expect.objectContaining({
              find: "Liability is unlimited.",
              replace: "Liability is capped at fees paid.",
            }),
            // A missing clause goes in after the clause the model named.
            expect.objectContaining({
              find: "Payment is due in 30 days.",
              replace:
                "Payment is due in 30 days.\n\nEnglish law governs this agreement.",
            }),
          ],
        }),
      );
      expect(docs.loadCurrentVersionBytes).toHaveBeenCalledWith("doc-1", db, "v1");
      const byRule = new Map(result.findings.map((item) => [item.ruleId, item]));
      expect(byRule.get("cap")?.edit?.edit_id).toBe("e1");
      expect(byRule.get("law")?.edit?.edit_id).toBe("e2");
      expect(result).toMatchObject({
        documentId: "doc-1",
        editedVersionId: "v2",
        documentName: "Supply.docx",
      });
      expect(
        writes.find((write) => write.table === "playbook_runs" && write.op === "insert")
          ?.payload,
      ).toMatchObject({ document_id: "doc-1" });
      expect(
        writes.find(
          (write) =>
            write.table === "playbook_runs" &&
            write.op === "update" &&
            write.payload.status === "completed",
        )?.payload,
      ).toMatchObject({ edited_version_id: "v2" });
    });

    it("keeps a suggestion that could not be located as text", async () => {
      const { db } = setup();
      docs.applyTrackedEditsToDocument.mockResolvedValue({
        ok: true,
        version_id: "v2",
        version_number: 2,
        storage_path: "edited.docx",
        download_url: "/download",
        annotations: [annotation("e2")],
        errors: [{ index: 0, reason: "Not found." }],
      });

      const result = await review(db);

      const byRule = new Map(result.findings.map((item) => [item.ruleId, item]));
      expect(byRule.get("cap")?.edit).toBeUndefined();
      expect(byRule.get("law")?.edit?.edit_id).toBe("e2");
    });

    it("reviews a PDF as text without editing it", async () => {
      const { db } = setup("pdf");

      const result = await review(db, { documentText: "Liability is unlimited." });

      expect(docs.applyTrackedEditsToDocument).not.toHaveBeenCalled();
      expect(result.editedVersionId).toBeNull();
      expect(result.status).toBe("completed");
    });
  });
  it("requires complete rules before a review, even though autosave accepts them", async () => {
    const { db, writes } = database([
      book({ content_json: { name: "Guide", topics: [] } }),
    ]);
    await expect(
      reviewWithPlaybook({
        userId: "owner",
        playbookId: "book",
        documentText: "Contract",
        model: "claude-opus-5",
        reviewMode: "strict",
        db,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(completeText).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

describe("playbook roles and sharing", () => {
  const people = [
    { user_id: "owner", email: "owner@example.com", display_name: "Olive", profile_photo: null },
    { user_id: "editor", email: "editor@example.com", display_name: "Ed", profile_photo: null },
    { user_id: "reader", email: "reader@example.com", display_name: "Rae", profile_photo: null },
    { user_id: "boss", email: "boss@example.com", display_name: "Bo", profile_photo: null },
  ];
  const content = blankPlaybookContent("Changed");

  it("gives personal recipients the role they were shared with", async () => {
    const { db, tables } = database([book()], [], people);
    await sharePlaybook(
      "owner",
      "owner@example.com",
      "book",
      { emails: [" Editor@Example.com ", "editor@example.com"], role: "editor" },
      db,
    );
    await sharePlaybook(
      "owner",
      "owner@example.com",
      "book",
      { emails: ["reader@example.com"], role: "viewer" },
      db,
    );
    expect(
      tables.playbook_shares.map((row) => [row.shared_with_email, row.role]),
    ).toEqual([
      ["editor@example.com", "editor"],
      ["reader@example.com", "viewer"],
    ]);

    // An editor changes the rules, not the access.
    const edited = await updatePlaybookContent(
      "editor", "book", content, db, {}, "editor@example.com",
    );
    expect(edited).toMatchObject({ role: "editor", canEdit: true, canManageAccess: false, isCreator: false, sharedWith: [] });
    await expect(
      sharePlaybook("editor", "editor@example.com", "book", { emails: ["boss@example.com"], role: "viewer" }, db),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      deletePlaybook("editor", "book", db, "editor@example.com"),
    ).rejects.toMatchObject({ status: 403 });

    // A viewer only reads and runs.
    await expect(
      updatePlaybookContent("reader", "book", content, db, {}, "reader@example.com"),
    ).rejects.toMatchObject({ status: 403 });

    // The owner sees who it is shared with; nobody else does.
    expect((await getPlaybook("owner", "book", db)).sharedWith).toEqual([
      "editor@example.com",
      "reader@example.com",
    ]);
    expect(
      (await getPlaybook("reader", "book", db, "reader@example.com")).sharedWith,
    ).toEqual([]);

    // Re-sharing changes the role; revoking removes it.
    await sharePlaybook("owner", "owner@example.com", "book", { emails: ["reader@example.com"], role: "editor" }, db);
    expect(
      (await getPlaybook("reader", "book", db, "reader@example.com")).role,
    ).toBe("editor");
    const share = tables.playbook_shares.find((row) => row.shared_with_email === "reader@example.com")!;
    await revokePlaybookShare("owner", "owner@example.com", "book", String(share.id), db);
    await expect(
      getPlaybook("reader", "book", db, "reader@example.com"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses shares with unknown people or the sharer", async () => {
    const { db, tables } = database([book()], [], people);
    await expect(
      sharePlaybook("owner", "owner@example.com", "book", { emails: ["nobody@example.com"], role: "viewer" }, db),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sharePlaybook("owner", "owner@example.com", "book", { emails: ["Owner@example.com"], role: "viewer" }, db),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      sharePlaybook("owner", "owner@example.com", "book", { emails: ["reader@example.com"], role: "deny" }, db),
    ).rejects.toMatchObject({ status: 400 });
    expect(tables.playbook_shares).toHaveLength(0);
  });

  it("lets members view a public organization playbook and edit only when given the role", async () => {
    const members = [
      { user_id: "owner", org_id: ORG, role: "member" },
      { user_id: "editor", org_id: ORG, role: "member" },
      { user_id: "reader", org_id: ORG, role: "member" },
      { user_id: "boss", org_id: ORG, role: "owner" },
    ];
    const { db } = database(
      [book({ org_id: ORG, visibility: "organization" })],
      members,
      people,
    );
    expect(await getPlaybook("reader", "book", db)).toMatchObject({ role: "viewer", canEdit: false });
    expect(await getPlaybook("boss", "book", db)).toMatchObject({ role: "owner", canManageAccess: true });

    await sharePlaybook("owner", "owner@example.com", "book", { emails: ["editor@example.com"], role: "editor" }, db);
    await sharePlaybook("owner", "owner@example.com", "book", { emails: ["reader@example.com"], role: "deny" }, db);
    expect(await getPlaybook("editor", "book", db)).toMatchObject({ role: "editor", canEdit: true });
    await expect(getPlaybook("reader", "book", db)).rejects.toMatchObject({ status: 404 });
    expect(
      (await listPlaybooks("reader", db, { workspace: ORG })).map((item) => item.id),
    ).toEqual([]);

    // Only owners see who is denied.
    const ownerView = await listPlaybookPeople("owner", "owner@example.com", "book", db);
    const editorView = await listPlaybookPeople("editor", "editor@example.com", "book", db);
    expect(ownerView.members.map((member) => [member.email, member.role])).toContainEqual(["reader@example.com", "deny"]);
    expect(editorView.members.some((member) => member.role === "deny")).toBe(false);
    expect(ownerView.members).toContainEqual(
      expect.objectContaining({ email: "boss@example.com", role: "owner" }),
    );

    // Organization owners own a public playbook already.
    await expect(
      sharePlaybook("owner", "owner@example.com", "book", { emails: ["boss@example.com"], role: "viewer" }, db),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("shares a private organization playbook only with chosen members", async () => {
    const { db } = database(
      [book({ org_id: ORG })],
      [
        { user_id: "owner", org_id: ORG, role: "member" },
        { user_id: "editor", org_id: ORG, role: "member" },
        { user_id: "boss", org_id: ORG, role: "owner" },
      ],
      people,
    );
    // Private is private, an organization owner included.
    await expect(getPlaybook("boss", "book", db)).rejects.toMatchObject({ status: 404 });
    await sharePlaybook("owner", "owner@example.com", "book", { emails: ["editor@example.com"], role: "viewer" }, db);
    expect(
      (await listPlaybooks("editor", db, { workspace: ORG })).map((item) => [item.id, item.role]),
    ).toEqual([["book", "viewer"]]);
    // Someone outside the organization cannot be added.
    await expect(
      sharePlaybook("owner", "owner@example.com", "book", { emails: ["reader@example.com"], role: "viewer" }, db),
    ).rejects.toMatchObject({ status: 400 });
    // Opening it to everyone is an owner's decision.
    await expect(
      updatePlaybookContent("editor", "book", blankPlaybookContent("Guide"), db, { visibility: "organization" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

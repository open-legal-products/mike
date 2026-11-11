import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeText, getUserApiKeys, recordAudit, storage } = vi.hoisted(() => ({
  completeText: vi.fn(),
  recordAudit: vi.fn(),
  getUserApiKeys: vi.fn(),
  storage: {
    deleteFile: vi.fn(),
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
  },
}));
vi.mock("../../../lib/llm", async (original) => ({
  ...(await original<typeof import("../../../lib/llm")>()),
  completeText,
}));
vi.mock("../../../lib/providerCredentials/index", () => ({ getUserApiKeys }));
vi.mock("../../../lib/audit", () => ({ recordAudit }));
vi.mock("../../../lib/storage", async (original) => ({
  ...(await original<typeof import("../../../lib/storage")>()),
  ...storage,
}));

import { DbJobDeferredError, type DbJob } from "../../../lib/dbq/types";
import { processClaimedJob } from "../../../lib/dbq/runner";
import type { Db } from "../../../lib/supabase";
import {
  blankPlaybookContent,
  compilePlaybookImport,
  INTERRUPTED_IMPORT_ERROR,
  INTERRUPTED_RUN_ERROR,
  PLAYBOOK_EDITED_DURING_REPLACEMENT_ERROR,
  playbookReviewWork,
  runPlaybookReview,
} from "../playbooks.operations";
import {
  handlePlaybookImport,
  handlePlaybookReview,
  markPlaybookImportJobFailed,
  markPlaybookReviewJobFailed,
  queuePlaybookImport,
  queuePlaybookReview,
} from "../playbooks.jobs";
import { database, type Row } from "./playbookTestDb";

const MODEL = "claude-opus-5";
const STAGED_KEY =
  "playbooks/owner/imports/11111111-2222-4333-8444-555555555555.docx";
const reviewed = (summary: string) =>
  JSON.stringify({ summary, findings: [] });

function book(overrides: Row = {}): Row {
  return {
    id: "book",
    user_id: "owner",
    org_id: null,
    visibility: "private",
    name: "Guide",
    description: "",
    content_json: blankPlaybookContent("Guide"),
    created_at: "2026-10-17",
    updated_at: "2026-10-17",
    ...overrides,
  };
}

/** A run as the review route stores it, with rules the book no longer has. */
function runRow(overrides: Row = {}): Row {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    playbook_id: "book",
    user_id: "owner",
    model: MODEL,
    document_name: "msa.txt",
    document_id: null,
    review_mode: "strict",
    review_scope: "full",
    status: "running",
    summary: null,
    findings_json: [],
    content_json: {
      ...blankPlaybookContent("Guide"),
      rules: [
        { id: "cap", name: "Snapshot cap rule", concept: "A cap on liability." },
      ],
    },
    error: null,
    started_at: now,
    updated_at: now,
    completed_at: null,
    ...overrides,
  };
}

const reviewPayload = {
  runId: "run-1",
  documentText: "Contract",
  instructions: null,
  userEmail: null,
  expectedVersion: null,
};

function job(
  kind: string,
  payload: Record<string, unknown>,
  attempts = 1,
): DbJob {
  const now = new Date().toISOString();
  return {
    id: "job-1",
    kind,
    payload,
    status: "running",
    attempts,
    max_attempts: 3,
    run_at: now,
    claimed_at: now,
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: now,
  };
}

const silent = () => new Date(Date.now() - 10 * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  getUserApiKeys.mockResolvedValue({ claude: "test-key" });
  completeText.mockResolvedValue(reviewed("Reviewed"));
  storage.deleteFile.mockResolvedValue(undefined);
  storage.uploadFile.mockResolvedValue(undefined);
  recordAudit.mockResolvedValue(undefined);
});

/** The audit rows recorded for one action. */
const audited = (action: string) =>
  recordAudit.mock.calls
    .map(([, event]) => event)
    .filter((event) => event.action === action);
afterEach(() => vi.unstubAllEnvs());

describe("queueing a playbook review", () => {
  it.each(["running", "read_error", "read_throw"])(
    "does not fail an inline publication still in flight after a %s reconciliation",
    async (reconciliation) => {
      vi.stubEnv("DB_JOBS_ENABLED", "false");
      const { db, tables, writes } = database([book()]);
      const rpc = db.rpc.bind(db);
      let dispatched = false;
      let finishCommit!: () => PromiseLike<unknown>;
      db.rpc = ((name: string, args: Record<string, unknown>) => {
        // The response timed out before the server reached the run lock.
        // Its transaction may still complete, modeled by finishCommit below.
        finishCommit = () => rpc(name, args);
        dispatched = true;
        return Promise.resolve({ data: null, error: { code: "08006", message: "response lost" } });
      }) as unknown as Db["rpc"];
      const from = db.from.bind(db);
      db.from = ((table: string) => {
        const query = from(table) as unknown as { maybeSingle: () => Promise<unknown> };
        const read = query.maybeSingle.bind(query);
        query.maybeSingle = async () => {
          if (table === "playbook_runs" && dispatched && reconciliation !== "running") {
            if (reconciliation === "read_throw") throw new Error("read unavailable");
            return { data: null, error: { code: "08006", message: "read unavailable" } };
          }
          return read();
        };
        return query;
      }) as unknown as Db["from"];
      let inlineSettled = false;
      const warn = vi.spyOn(console, "warn").mockImplementation((label) => {
        if (label === "[playbooks] inline job failed") inlineSettled = true;
      });
      try {
        await queuePlaybookReview({ userId: "owner", playbookId: "book", documentText: "Contract",
          model: MODEL, reviewMode: "strict", db });
        await vi.waitFor(() => expect(inlineSettled).toBe(true));
        expect(tables.playbook_runs[0].status).toBe("running");
        expect(writes.filter((write) => write.table === "playbook_runs" && write.payload.status === "failed")).toEqual([]);
        await finishCommit();
        expect(tables.playbook_runs[0]).toMatchObject({ status: "completed", summary: "Reviewed" });
        expect(storage.deleteFile).not.toHaveBeenCalled();
      } finally { warn.mockRestore(); }
    },
  );

  it("records a deterministic publication validation failure instead of leaving it unresolved", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const { db, tables } = database([book()]);
    db.rpc = (() => Promise.resolve({ data: null, error: { code: "22023", message: "invalid prepared mapping" } })) as unknown as Db["rpc"];
    await queuePlaybookReview({ userId: "owner", playbookId: "book", documentText: "Contract",
      model: MODEL, reviewMode: "strict", db });
    await vi.waitFor(() => expect(tables.playbook_runs[0].status).toBe("failed"));
    expect(tables.playbook_runs[0].error).toBe("The review failed. Try again.");
  });

  it("stores the run and queues a job for it instead of running the model", async () => {
    const { db, tables } = database([book()]);

    const run = await queuePlaybookReview({
      userId: "owner",
      playbookId: "book",
      documentText: "Contract",
      model: MODEL,
      reviewMode: "strict",
      db,
    });

    expect(run).toMatchObject({ status: "running" });
    expect(tables.playbook_runs[0]).toMatchObject({ id: run.id, status: "running" });
    expect(tables.db_jobs).toEqual([
      expect.objectContaining({
        kind: "playbook.review",
        dedupe_key: `playbook.review:${run.id}`,
        payload: expect.objectContaining({
          runId: run.id,
          // What account erasure purges queued jobs by.
          userId: "owner",
          documentText: "Contract",
        }),
      }),
    ]);
    expect(completeText).not.toHaveBeenCalled();
  });

  it("still completes the review in this process when the job runner is off", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const { db, tables } = database([book()]);

    await queuePlaybookReview({
      userId: "owner",
      playbookId: "book",
      documentText: "Contract",
      model: MODEL,
      reviewMode: "strict",
      db,
    });

    expect(tables.db_jobs ?? []).toEqual([]);
    await vi.waitFor(() =>
      expect(tables.playbook_runs[0]).toMatchObject({ status: "completed" }),
    );
  });
});

describe("the playbook.review job", () => {
  it("returns the exact different stored winner rather than this claim's model output", async () => {
    vi.stubEnv("DOWNLOAD_SIGNING_SECRET", "synthetic-test-only");
    const { db, tables } = database([book()]);
    const row = runRow({ document_id: "doc-1" });
    tables.playbook_runs.push(row);
    const work = playbookReviewWork(row, { ...reviewPayload, userId: "owner" });
    const savedFindings = [{ id: "saved-finding", ruleId: "cap", ruleName: "Stored winner",
      status: "acceptable", analysis: "Already reviewed", suggestedText: "", quote: "", location: "", insertAfter: "", topicId: null }];
    tables.document_versions = [{ id: "saved-version", document_id: "doc-1", version_number: 7,
      filename: "Saved.docx", storage_path: "saved.docx", deleted_at: null }];
    completeText.mockImplementation(async () => {
      Object.assign(row, { status: "completed", summary: "The other claim won", findings_json: savedFindings,
        edited_version_id: "saved-version", completed_at: "2026-11-07T10:00:00.000Z" });
      return reviewed("This claim must not be returned");
    });
    const result = await runPlaybookReview(db, work, { claude: "test-key" });
    expect(result).toMatchObject({ status: "completed", summary: "The other claim won",
      findings: savedFindings, editedVersionId: "saved-version", editedVersionNumber: 7,
      completedAt: "2026-11-07T10:00:00.000Z" });
    expect(result.editedDownloadUrl).toBeTruthy();
    expect(audited("playbook.run")).toEqual([]);
  });

  it.each(["audit", "signing", "version_lookup"])("keeps a saved completed result after postcommit %s failure", async (fault) => {
    vi.stubEnv("DOWNLOAD_SIGNING_SECRET", fault === "signing" ? "" : "synthetic-test-only");
    const { db, tables, writes } = database([book()]);
    const row = runRow({ document_id: "doc-1" });
    tables.playbook_runs.push(row);
    const work = playbookReviewWork(row, { ...reviewPayload, userId: "owner" });
    const savedFindings = [{ id: "stored-finding", ruleName: "Stored finding", status: "acceptable", analysis: "Saved analysis" }];
    tables.document_versions = [{ id: "saved-version", document_id: "doc-1", version_number: 2,
      filename: "Saved.docx", storage_path: "saved.docx", deleted_at: null }];
    db.rpc = (() => {
      Object.assign(row, { status: "completed", summary: "Saved summary", findings_json: savedFindings,
        edited_version_id: "saved-version", completed_at: new Date().toISOString() });
      return Promise.resolve({ data: { disposition: "published", run: structuredClone(row) }, error: null });
    }) as unknown as Db["rpc"];
    if (fault === "audit") recordAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    if (fault === "version_lookup") {
      const from = db.from.bind(db);
      db.from = ((table: string) => {
        const query = from(table) as unknown as { maybeSingle: () => Promise<unknown> };
        if (table === "document_versions") query.maybeSingle = async () => ({ data: null, error: { code: "08006" } });
        return query;
      }) as unknown as Db["from"];
    }
    const result = await runPlaybookReview(db, work, { claude: "test-key" });
    expect(result).toMatchObject({ status: "completed", summary: "Saved summary",
      findings: savedFindings, editedVersionId: "saved-version" });
    expect(row.status).toBe("completed");
    expect(writes.filter((write) => write.table === "playbook_runs" && write.payload.status === "failed")).toEqual([]);
    if (fault !== "audit") expect(result.editedDownloadUrl).toBeNull();
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });

  it.each([1, 3])("keeps the queued retry budget for unresolved publication at attempt %i", async (attempt) => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow({ updated_at: silent() }));
    const claimed = job("playbook.review", reviewPayload, attempt);
    tables.db_jobs = [claimed as unknown as Row];
    const publish = db.rpc.bind(db);
    db.rpc = (() => Promise.resolve({ data: null, error: { code: "08006", message: "response lost" } })) as unknown as Db["rpc"];
    await processClaimedJob(db, { "playbook.review": handlePlaybookReview }, claimed,
      { "playbook.review": markPlaybookReviewJobFailed });
    expect(tables.db_jobs[0].status).toBe(attempt === 1 ? "pending" : "failed");
    expect(tables.playbook_runs[0].status).toBe(attempt === 1 ? "running" : "failed");
    if (attempt === 3) {
      expect(tables.playbook_runs[0].error).toBe(INTERRUPTED_RUN_ERROR);
      // Exhaustion deliberately ends queued work. An old request that only
      // reaches its guarded publication afterwards cannot revive that run.
      const late = await publish("publish_playbook_review", {
        p_run_id: "run-1", p_user_id: "owner", p_summary: "Late", p_findings: [], p_version: null,
      });
      expect(late.data).toMatchObject({ disposition: "terminal" });
      expect(tables.playbook_runs[0].summary).toBeNull();
    }
  });

  it("ends a queued deterministic SQL validation failure without rerunning the model", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow());
    const claimed = job("playbook.review", reviewPayload);
    tables.db_jobs = [claimed as unknown as Row];
    db.rpc = (() => Promise.resolve({ data: null, error: { code: "22023", message: "invalid prepared mapping" } })) as unknown as Db["rpc"];
    await processClaimedJob(db, { "playbook.review": handlePlaybookReview }, claimed,
      { "playbook.review": markPlaybookReviewJobFailed });
    expect(tables.db_jobs[0].status).toBe("done");
    expect(tables.playbook_runs[0].status).toBe("failed");
    expect(completeText).toHaveBeenCalledTimes(1);
  });

  it("runs the review from the run's stored rules and completes it", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow());

    await handlePlaybookReview(db, job("playbook.review", reviewPayload));

    // The snapshot on the run, not the book's current (blank) rules.
    expect(completeText.mock.lastCall?.[0].user).toContain("Snapshot cap rule");
    expect(tables.playbook_runs[0]).toMatchObject({
      status: "completed",
      summary: "Reviewed",
    });
  });

  it("records the completed review in the audit log with its outcome counts", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow({ document_id: "doc-1" }));
    completeText.mockResolvedValue(
      JSON.stringify({
        summary: "Reviewed",
        findings: [
          {
            ruleId: "cap",
            ruleName: "Snapshot cap rule",
            status: "unacceptable",
            quote: "",
            analysis: "Uncapped liability.",
          },
        ],
      }),
    );

    await handlePlaybookReview(db, job("playbook.review", reviewPayload));

    expect(audited("playbook.run")).toEqual([
      expect.objectContaining({
        userId: "owner",
        status: "completed",
        surface: "playbooks",
        model: MODEL,
        documentId: "doc-1",
        detail: {
          playbook_id: "book",
          run_id: "run-1",
          scope: "full",
          posture: "strict",
          outcomes: { unacceptable: 1 },
        },
      }),
    ]);
    // Counts only: what the finding said stays out of the audit row.
    expect(JSON.stringify(recordAudit.mock.calls)).not.toContain(
      "Uncapped liability",
    );
  });

  it("fails the run when the user lost access to the playbook while the job waited", async () => {
    const { db, tables } = database([book({ user_id: "someone-else" })]);
    tables.playbook_runs.push(runRow());

    await handlePlaybookReview(db, job("playbook.review", reviewPayload));

    expect(completeText).not.toHaveBeenCalled();
    expect(tables.playbook_runs[0]).toMatchObject({
      status: "failed",
      error: "Playbook not found.",
    });
    expect(audited("playbook.run")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
  });

  it("does nothing for a run that already finished", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow({ status: "completed", summary: "Done" }));

    await handlePlaybookReview(db, job("playbook.review", reviewPayload, 2));

    expect(completeText).not.toHaveBeenCalled();
    expect(tables.playbook_runs[0]).toMatchObject({
      status: "completed",
      summary: "Done",
    });
  });

  it("cannot overwrite the outcome another claim of the same run recorded", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow());
    completeText.mockImplementation(async () => {
      // A second claim of the job finishes first.
      Object.assign(tables.playbook_runs[0], {
        status: "completed",
        summary: "First claim",
      });
      return reviewed("Second claim");
    });

    await handlePlaybookReview(db, job("playbook.review", reviewPayload));

    expect(tables.playbook_runs[0]).toMatchObject({ summary: "First claim" });
    // The claim that recorded the outcome audits it; this one does not.
    expect(audited("playbook.run")).toEqual([]);
  });

  it("defers a re-claimed job while an earlier claim still heartbeats the run", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow());

    await expect(
      handlePlaybookReview(db, job("playbook.review", reviewPayload, 2)),
    ).rejects.toBeInstanceOf(DbJobDeferredError);
    expect(completeText).not.toHaveBeenCalled();

    // Once the earlier claim falls silent, the re-claim runs the review.
    Object.assign(tables.playbook_runs[0], { updated_at: silent() });
    await handlePlaybookReview(db, job("playbook.review", reviewPayload, 2));
    expect(tables.playbook_runs[0]).toMatchObject({ status: "completed" });
  });

  it("records a failed review on the run and ends the job without a retry", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow());
    completeText.mockRejectedValueOnce(new Error("provider secret sk-ant-123"));

    await expect(
      handlePlaybookReview(db, job("playbook.review", reviewPayload)),
    ).resolves.toBeUndefined();

    expect(tables.playbook_runs[0]).toMatchObject({
      status: "failed",
      error: "The review failed. Try again.",
    });
    expect(audited("playbook.run")).toEqual([
      expect.objectContaining({
        status: "failed",
        surface: "playbooks",
        detail: expect.objectContaining({ run_id: "run-1" }),
      }),
    ]);
  });
});

async function sourceDocx(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Liability is capped at fees paid in the prior 12 months.</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

function compiled(name: string): string {
  return JSON.stringify({
    name,
    description: "",
    representedParty: "Customer",
    documentTypes: [],
    jurisdictions: [],
    topics: [
      {
        name: "Liability",
        rules: [
          {
            name: "Liability cap",
            concept: "Determine whether liability is capped.",
            scope: "clause",
            required: true,
            guidance: "",
            standard: null,
            fallbacks: [],
            unacceptable: [],
            sourceRefs: ["P1"],
          },
        ],
      },
    ],
  });
}

function importRow(overrides: Row = {}): Row {
  const now = new Date().toISOString();
  return {
    id: "imp-1",
    user_id: "owner",
    filename: "Standards.docx",
    requested_name: null,
    model: MODEL,
    status: "running",
    stage: "checking_model",
    error: null,
    playbook_id: null,
    org_id: null,
    started_at: now,
    completed_at: null,
    updated_at: now,
    ...overrides,
  };
}

const importPayload = {
  attemptId: "imp-1",
  userId: "owner",
  userEmail: null,
  filename: "Standards.docx",
  name: null,
  model: MODEL,
  orgId: null,
  replacePlaybookId: null,
  newPlaybookId: "new-book",
  startedAt: new Date().toISOString(),
  storageKey: STAGED_KEY,
};

// Before #819 split the write, main recorded these as failed too (an upload
// fault) or as text only (a download fault). Preparation publishes nothing,
// so the run must end, not wait on an outcome that cannot exist.
describe("a review whose tracked changes could not be prepared", () => {
  const payload = {
    ...reviewPayload,
    userId: "owner",
    expectedVersion: { id: "v1", storagePath: "source.docx" },
  };
  function setup() {
    const fixture = database([book()]);
    fixture.tables.playbook_runs.push(runRow({ document_id: "doc-1" }));
    fixture.tables.documents = [{ id: "doc-1", user_id: "owner", project_id: null,
      org_id: null, workflow_id: null, current_version_id: "v1" }];
    fixture.tables.document_versions = [{ id: "v1", document_id: "doc-1",
      storage_path: "source.docx", filename: "Msa.docx", deleted_at: null }];
    completeText.mockResolvedValue(JSON.stringify({ summary: "Reviewed", findings: [{
      ruleId: "cap", ruleName: "Snapshot cap rule", status: "unacceptable", quote: "Contract",
      analysis: "Uncapped.", suggestedText: "Capped contract",
    }] }));
    storage.downloadFile.mockRejectedValue(new Error("storage unavailable"));
    return fixture;
  }

  it("ends the run as failed when a chat-started review cannot read the document", async () => {
    const { db, tables } = setup();
    const work = playbookReviewWork(tables.playbook_runs[0], payload);

    // The chat tool reports the rejection; the run must not stay `running`.
    const failure = await runPlaybookReview(db, work, { claude: "test-key" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(tables.playbook_runs[0]).toMatchObject({
      status: "failed",
      error: "The review failed. Try again.",
    });
  });

  it("ends the queued job without rerunning the model", async () => {
    const { db, tables } = setup();
    const claimed = job("playbook.review", payload);
    tables.db_jobs = [claimed as unknown as Row];

    await processClaimedJob(db, { "playbook.review": handlePlaybookReview }, claimed,
      { "playbook.review": markPlaybookReviewJobFailed });

    expect(tables.db_jobs[0].status).toBe("done");
    expect(tables.playbook_runs[0].status).toBe("failed");
    expect(completeText).toHaveBeenCalledTimes(1);
  });
});

describe("the playbook.import job", () => {
  it("compiles the staged upload into the import's playbook and clears the upload", async () => {
    const { db, tables } = database([]);
    tables.playbook_imports = [importRow()];
    storage.downloadFile.mockResolvedValue(await sourceDocx());
    completeText.mockResolvedValue(compiled("Standards"));

    await handlePlaybookImport(db, job("playbook.import", importPayload));

    expect(storage.downloadFile).toHaveBeenCalledWith(STAGED_KEY);
    expect(tables.playbooks.map((row) => row.id)).toEqual(["new-book"]);
    expect(tables.playbook_imports[0]).toMatchObject({
      status: "completed",
      playbook_id: "new-book",
    });
    expect(storage.deleteFile).toHaveBeenCalledWith(STAGED_KEY);
    expect(audited("playbook.imported")).toEqual([
      expect.objectContaining({
        status: "completed",
        surface: "playbooks",
        title: "Standards",
        detail: { import_id: "imp-1", playbook_id: "new-book" },
      }),
    ]);
  });

  it("records a replacement as playbook.replaced", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_imports = [importRow({ playbook_id: "book" })];
    storage.downloadFile.mockResolvedValue(await sourceDocx());
    completeText.mockResolvedValue(compiled("Guide v2"));

    await handlePlaybookImport(
      db,
      job("playbook.import", { ...importPayload, replacePlaybookId: "book" }),
    );

    expect(tables.playbook_imports[0]).toMatchObject({ status: "completed" });
    expect(audited("playbook.replaced")).toEqual([
      expect.objectContaining({
        status: "completed",
        surface: "playbooks",
        detail: { import_id: "imp-1", playbook_id: "book" },
      }),
    ]);
    expect(audited("playbook.imported")).toEqual([]);
  });

  it("records nothing when another claim finished the attempt first", async () => {
    // Two claims of one import: the other one completed the row after this
    // one checked it, so this one's outcome write matches nothing.
    const { db, tables } = database([]);
    tables.playbook_imports = [importRow({ status: "completed" })];
    storage.downloadFile.mockResolvedValue(await sourceDocx());
    completeText.mockResolvedValue(compiled("Standards"));

    await compilePlaybookImport(db, importPayload, Buffer.from(await sourceDocx()));

    expect(audited("playbook.imported")).toEqual([]);
  });

  it("records a failed import with the stage it stopped at", async () => {
    const { db, tables } = database([]);
    tables.playbook_imports = [importRow()];
    storage.downloadFile.mockResolvedValue(null);

    await handlePlaybookImport(db, job("playbook.import", importPayload));

    expect(tables.playbook_imports[0]).toMatchObject({ status: "failed" });
    expect(audited("playbook.imported")).toEqual([
      expect.objectContaining({
        status: "failed",
        surface: "playbooks",
        detail: expect.objectContaining({
          import_id: "imp-1",
          stage: "validating_file",
        }),
      }),
    ]);
  });
});

describe("a replacement import racing an edit", () => {
  const VERSION = "2026-10-17T09:00:00.000Z";
  const replacement = { ...importPayload, replacePlaybookId: "book" };

  it("records the version of the playbook it replaces", async () => {
    const { db, tables } = database([book({ updated_at: VERSION })]);

    await queuePlaybookImport({
      userId: "owner",
      model: MODEL,
      playbookId: "book",
      source: { storageKey: STAGED_KEY, filename: "Standards.docx", size: 10 },
      db,
    });

    expect(tables.playbook_imports[0]).toMatchObject({
      playbook_id: "book",
      target_updated_at: VERSION,
    });
    expect(tables.db_jobs[0].payload).toMatchObject({
      replacePlaybookId: "book",
      targetUpdatedAt: VERSION,
    });
  });

  it("fails the import and keeps an edit saved while it compiled", async () => {
    const edited = blankPlaybookContent("Edited meanwhile");
    // The playbook was saved after the import began from VERSION.
    const { db, tables } = database([
      book({
        updated_at: "2026-10-17T09:05:00.000Z",
        content_json: edited,
        source_storage_key: "playbooks/owner/book/source-old.docx",
      }),
    ]);
    tables.playbook_imports = [
      importRow({ playbook_id: "book", target_updated_at: VERSION }),
    ];
    storage.downloadFile.mockResolvedValue(await sourceDocx());
    completeText.mockResolvedValue(compiled("Standards"));

    await handlePlaybookImport(
      db,
      job("playbook.import", { ...replacement, targetUpdatedAt: VERSION }),
    );

    expect(tables.playbook_imports[0]).toMatchObject({
      status: "failed",
      error: PLAYBOOK_EDITED_DURING_REPLACEMENT_ERROR,
    });
    expect(tables.playbooks[0]).toMatchObject({
      content_json: edited,
      updated_at: "2026-10-17T09:05:00.000Z",
      source_storage_key: "playbooks/owner/book/source-old.docx",
    });
    // The new source was uploaded before the save; it goes, the old stays.
    const [uploaded] = storage.uploadFile.mock.calls[0] as [string];
    expect(storage.deleteFile).toHaveBeenCalledWith(uploaded);
    expect(storage.deleteFile).not.toHaveBeenCalledWith(
      "playbooks/owner/book/source-old.docx",
    );
  });

  it("replaces the content when the playbook is still the version it began from", async () => {
    const { db, tables } = database([book({ updated_at: VERSION })]);
    tables.playbook_imports = [
      importRow({ playbook_id: "book", target_updated_at: VERSION }),
    ];
    storage.downloadFile.mockResolvedValue(await sourceDocx());
    completeText.mockResolvedValue(compiled("Standards"));

    await handlePlaybookImport(
      db,
      job("playbook.import", { ...replacement, targetUpdatedAt: VERSION }),
    );

    expect(tables.playbook_imports[0]).toMatchObject({
      status: "completed",
      playbook_id: "book",
    });
    expect(tables.playbooks[0].name).toBe("Standards");
    expect(tables.playbooks[0].updated_at).not.toBe(VERSION);
  });

  it("completes a re-run whose earlier run already saved the replacement", async () => {
    // Run one saved (moving updated_at) but died before recording it.
    const saved = "playbooks/owner/book/source-imp-1.docx";
    const { db, tables } = database([
      book({ updated_at: "2026-10-17T09:05:00.000Z", source_storage_key: saved }),
    ]);
    tables.playbook_imports = [
      importRow({
        playbook_id: "book",
        target_updated_at: VERSION,
        started_at: silent(),
        updated_at: silent(),
      }),
    ];
    storage.downloadFile.mockResolvedValue(await sourceDocx());
    completeText.mockResolvedValue(compiled("Standards"));

    await handlePlaybookImport(
      db,
      job("playbook.import", { ...replacement, targetUpdatedAt: VERSION }, 2),
    );

    expect(tables.playbook_imports[0]).toMatchObject({ status: "completed" });
    expect(tables.playbooks[0].source_storage_key).toBe(saved);
    expect(storage.deleteFile).not.toHaveBeenCalledWith(saved);
  });
});

describe("a playbook job that runs out of attempts", () => {
  it("fails a still-running row with the interrupted message, and leaves a finished one", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow(), runRow({ id: "run-2", status: "completed" }));
    tables.playbook_imports = [importRow()];

    await markPlaybookReviewJobFailed(db, job("playbook.review", reviewPayload));
    await markPlaybookReviewJobFailed(
      db,
      job("playbook.review", { ...reviewPayload, runId: "run-2" }),
    );
    await markPlaybookImportJobFailed(db, job("playbook.import", importPayload));

    expect(tables.playbook_runs[0]).toMatchObject({
      status: "failed",
      error: INTERRUPTED_RUN_ERROR,
    });
    expect(tables.playbook_runs[1]).toMatchObject({ status: "completed" });
    expect(tables.playbook_imports[0]).toMatchObject({
      status: "failed",
      error: INTERRUPTED_IMPORT_ERROR,
    });
    // Nothing will read the staged upload again.
    expect(storage.deleteFile).toHaveBeenCalledWith(STAGED_KEY);
    // Only the rows this hook failed are audited, each once.
    expect(audited("playbook.run")).toEqual([
      expect.objectContaining({
        status: "failed",
        detail: expect.objectContaining({ run_id: "run-1" }),
      }),
    ]);
    expect(audited("playbook.imported")).toEqual([
      expect.objectContaining({
        status: "failed",
        detail: expect.objectContaining({ stage: "checking_model" }),
      }),
    ]);
  });
});

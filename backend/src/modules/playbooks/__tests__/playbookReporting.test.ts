import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeText, getUserApiKeys, reportError, storage } = vi.hoisted(
  () => ({
    completeText: vi.fn(),
    getUserApiKeys: vi.fn(),
    reportError: vi.fn(),
    storage: {
      deleteFile: vi.fn(),
      downloadFile: vi.fn(),
      uploadFile: vi.fn(),
    },
  }),
);
vi.mock("../../../lib/llm", async (original) => ({
  ...(await original<typeof import("../../../lib/llm")>()),
  completeText,
}));
vi.mock("../../../lib/providerCredentials/index", () => ({ getUserApiKeys }));
vi.mock("../../../lib/storage", async (original) => ({
  ...(await original<typeof import("../../../lib/storage")>()),
  ...storage,
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/observability/sentry", async (original) => ({
  ...(await original<typeof import("../../../lib/observability/sentry")>()),
  reportError,
}));

import type { DbJob } from "../../../lib/dbq/types";
import type { Db } from "../../../lib/supabase";
import { scrubEvent } from "../../../lib/observability/sentry";
import { diagnosticEvent } from "../../../lib/observability/sentryPrivacy";
import { blankPlaybookContent } from "../playbooks.operations";
import {
  handlePlaybookImport,
  handlePlaybookReview,
  queuePlaybookReview,
} from "../playbooks.jobs";
import { database, type Row } from "./playbookTestDb";

const MODEL = "claude-opus-5";
const RUN = "33333333-3333-4333-8333-333333333333";
const IMPORT = "44444444-4444-4444-8444-444444444444";
const STAGED_KEY =
  "playbooks/owner/imports/11111111-2222-4333-8444-555555555555.docx";
const FILENAME = "Confidential Standards.docx";

function book(): Row {
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
  };
}

function runRow(): Row {
  const now = new Date().toISOString();
  return {
    id: RUN,
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
    content_json: blankPlaybookContent("Guide"),
    error: null,
    started_at: now,
    updated_at: now,
    completed_at: null,
  };
}

function importRow(): Row {
  const now = new Date().toISOString();
  return {
    id: IMPORT,
    user_id: "owner",
    filename: FILENAME,
    model: MODEL,
    status: "running",
    stage: "checking_model",
    error: null,
    playbook_id: null,
    org_id: null,
    started_at: now,
    completed_at: null,
    updated_at: now,
  };
}

const reviewPayload = {
  runId: RUN,
  documentText: "Contract",
  instructions: null,
  userEmail: null,
  expectedVersion: null,
};

const importPayload = {
  attemptId: IMPORT,
  userId: "owner",
  userEmail: null,
  filename: FILENAME,
  name: null,
  model: MODEL,
  orgId: null,
  replacePlaybookId: null,
  newPlaybookId: "new-book",
  startedAt: new Date().toISOString(),
  storageKey: STAGED_KEY,
};

function job(kind: string, payload: Record<string, unknown>): DbJob {
  const now = new Date().toISOString();
  return {
    id: "job-1",
    kind,
    payload,
    status: "running",
    attempts: 1,
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

async function sourceDocx(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Liability is capped at fees paid in the prior 12 months.</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

/**
 * The test database, with chosen statements failing the way supabase-js
 * reports a refused statement: resolved with an error, not thrown.
 */
function failing(
  base: Db,
  fails: (table: string, op: "update" | "maybeSingle", values?: Row) => boolean,
): Db {
  const refused = { data: null, error: { code: "57014", message: "canceled" } };
  return {
    from: (table: string) => {
      const query = base.from(table) as unknown as Record<string, unknown>;
      const update = query.update as (values: Row) => unknown;
      const maybeSingle = query.maybeSingle as () => Promise<unknown>;
      query.update = (values: Row) => {
        if (fails(table, "update", values))
          query.then = (resolve: (value: unknown) => unknown) =>
            Promise.resolve(refused).then(resolve);
        return update(values);
      };
      query.maybeSingle = async () =>
        fails(table, "maybeSingle") ? refused : maybeSingle();
      return query;
    },
  } as unknown as Db;
}

/** The reports filed for one stage, as [error, context] pairs. */
const reportsAt = (stage: string) =>
  reportError.mock.calls.filter(([, context]) => context?.tags?.stage === stage);

beforeEach(() => {
  vi.clearAllMocks();
  getUserApiKeys.mockResolvedValue({ claude: "test-key" });
  storage.deleteFile.mockResolvedValue(undefined);
  storage.uploadFile.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reporting playbook job failures", () => {
  it("reports a review whose model call crashed, by stage, with ids only", async () => {
    const { db, tables } = database([book()]);
    tables.playbook_runs.push(runRow());
    const crash = new Error("provider socket hang up");
    completeText.mockRejectedValueOnce(crash);

    await handlePlaybookReview(db, job("playbook.review", reviewPayload));

    expect(reportsAt("review.model")).toEqual([
      [
        crash,
        expect.objectContaining({
          level: "error",
          tags: expect.objectContaining({
            component: "playbooks",
            stage: "review.model",
            job_kind: "playbook.review",
          }),
          extra: { run_id: RUN, playbook_id: "book" },
        }),
      ],
    ]);
  });

  it("reports an import whose output was still invalid after the automatic recompile", async () => {
    const { db, tables } = database([]);
    tables.playbook_imports = [importRow()];
    storage.downloadFile.mockResolvedValue(await sourceDocx());
    completeText.mockResolvedValue("not json at all");

    await handlePlaybookImport(db, job("playbook.import", importPayload));

    // Compiled, then recompiled once with the validation error, then reported.
    expect(completeText).toHaveBeenCalledTimes(2);
    expect(tables.playbook_imports[0]).toMatchObject({ status: "failed" });
    const reports = reportsAt("import.validate");
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toMatchObject({
      level: "warning",
      tags: {
        component: "playbooks",
        stage: "import.validate",
        job_kind: "playbook.import",
        file_type: "docx",
      },
      extra: { import_id: IMPORT },
    });
    // No file name, rule text, or email in what is offered to Sentry.
    expect(JSON.stringify(reports[0][1])).not.toContain("Confidential");
  });

  it("does not report an import refused for a reason the user is shown", async () => {
    const { db, tables } = database([]);
    tables.playbook_imports = [importRow()];
    storage.downloadFile.mockResolvedValue(null);
    const error = vi.spyOn(console, "error");

    await handlePlaybookImport(db, job("playbook.import", importPayload));

    expect(tables.playbook_imports[0]).toMatchObject({
      status: "failed",
      error: "The uploaded playbook could not be read.",
    });
    expect(reportError).not.toHaveBeenCalled();
    // Nor through the console bridge, which files every console.error.
    expect(error).not.toHaveBeenCalled();
  });

  it("reports a failure that could not be written to the import row", async () => {
    const { db: base, tables } = database([]);
    tables.playbook_imports = [importRow()];
    storage.downloadFile.mockResolvedValue(null);
    const db = failing(
      base,
      (table, op, values) =>
        table === "playbook_imports" &&
        op === "update" &&
        values?.status === "failed",
    );

    await expect(
      handlePlaybookImport(db, job("playbook.import", importPayload)),
    ).rejects.toThrow();

    // The refusal itself is not reported; losing its record is.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportsAt("import.record")[0][1]).toMatchObject({
      tags: { component: "playbooks", stage: "import.record" },
      extra: { import_id: IMPORT },
    });
  });

  it("reports the first failed heartbeat of a review, once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { db: base, tables } = database([book()]);
    tables.playbook_runs.push(runRow());
    const db = failing(
      base,
      (table, op, values) =>
        table === "playbook_runs" &&
        op === "update" &&
        Object.keys(values ?? {}).join() === "updated_at",
    );
    let answer!: (raw: string) => void;
    completeText.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const running = handlePlaybookReview(db, job("playbook.review", reviewPayload));
    await vi.waitFor(() => expect(completeText).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(90_000);
    answer(JSON.stringify({ summary: "Reviewed", findings: [] }));
    await running;

    expect(reportsAt("heartbeat")).toEqual([
      [
        expect.any(Error),
        expect.objectContaining({
          level: "warning",
          tags: expect.objectContaining({
            component: "playbooks",
            stage: "heartbeat",
            job_kind: "playbook.review",
          }),
          extra: { run_id: RUN },
        }),
      ],
    ]);
    expect(tables.playbook_runs[0]).toMatchObject({ status: "completed" });
  });

  it("reports an in-process job that ended without recording its outcome", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const { db: base, tables } = database([book()]);
    // The job cannot read its run back, so it ends with the row running.
    const db = failing(
      base,
      (table, op) => table === "playbook_runs" && op === "maybeSingle",
    );

    const run = await queuePlaybookReview({
      userId: "owner",
      playbookId: "book",
      documentText: "Contract",
      model: MODEL,
      reviewMode: "strict",
      db,
    });

    await vi.waitFor(() => expect(reportsAt("job.terminal")).toHaveLength(1));
    expect(reportsAt("job.terminal")[0][1]).toMatchObject({
      tags: {
        component: "playbooks",
        stage: "job.terminal",
        job_kind: "playbook.review",
      },
      extra: { run_id: run.id },
    });
    // The failure hook still ends the run for the user.
    await vi.waitFor(() =>
      expect(tables.playbook_runs[0]).toMatchObject({ status: "failed" }),
    );
  });

  it("reports a staged upload that could not be removed", async () => {
    const { db, tables } = database([]);
    tables.playbook_imports = [importRow()];
    storage.downloadFile.mockResolvedValue(null);
    storage.deleteFile.mockRejectedValue(new Error("storage unavailable"));

    await handlePlaybookImport(db, job("playbook.import", importPayload));

    expect(reportsAt("import.cleanup")[0][1]).toMatchObject({
      level: "warning",
      tags: { component: "playbooks", stage: "import.cleanup" },
      extra: { import_id: IMPORT },
    });
  });
});

describe("the outbound privacy boundary", () => {
  it("keeps the playbook component, stage, job kind, and ids", () => {
    const event = diagnosticEvent({
      tags: {
        component: "playbooks",
        stage: "import.validate",
        job_kind: "playbook.import",
        file_type: "pdf",
      },
      extra: { import_id: IMPORT, run_id: RUN, playbook_id: IMPORT, title: FILENAME },
      message: "anything",
    });

    expect(event.tags).toEqual({
      component: "playbooks",
      stage: "import.validate",
      job_kind: "playbook.import",
      file_type: "pdf",
    });
    expect(event.extra).toEqual({
      import_id: IMPORT,
      run_id: RUN,
      playbook_id: IMPORT,
    });
    expect(event.message).toBe("Failure in playbooks / import.validate");
  });

  it("keeps the ids through the before-send scrub that runs first", () => {
    // The SDK applies scrubEvent (beforeSend) before the transport filter
    // above; a key the scrub does not allow reaches the filter as
    // "[Filtered]" and is dropped there, however the filter lists it.
    const scrubbed = scrubEvent(
      {
        tags: { component: "playbooks", stage: "review.model" },
        extra: { run_id: RUN, playbook_id: IMPORT, import_id: IMPORT },
        exception: { values: [{ type: "Error", value: "boom" }] },
      } as never,
      {},
    );
    const event = diagnosticEvent(scrubbed as never);

    expect(event.extra).toEqual({
      run_id: RUN,
      playbook_id: IMPORT,
      import_id: IMPORT,
    });
  });
});

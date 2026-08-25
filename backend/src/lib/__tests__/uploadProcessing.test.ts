import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  downloadFile: vi.fn(),
  copyFile: vi.fn(),
  recordAudit: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return {
    ...actual,
    deleteFile: mocks.deleteFile,
    downloadFile: mocks.downloadFile,
    copyFile: mocks.copyFile,
    uploadFile: mocks.uploadFile,
  };
});

vi.mock("../audit", () => ({ recordAudit: mocks.recordAudit }));

import {
  cleanupUploadSessions,
  processUploadFile,
  processUploadJob,
} from "../uploadProcessing";

type QueryResult = { data?: unknown; error?: unknown };

function fakeDb(singleResults: Record<string, QueryResult[]> = {}) {
  class Query {
    constructor(private readonly table: string) {}
    select() { return this; }
    insert() { return this; }
    update() { return this; }
    upsert() { return this; }
    eq() { return this; }
    is() { return this; }
    in() { return this; }
    order() { return this; }
    limit() { return this; }
    single() {
      return Promise.resolve(
        singleResults[this.table]?.shift() ?? { data: null, error: null },
      );
    }
    maybeSingle() { return this.single(); }
    then(resolve: (result: QueryResult) => unknown) {
      return Promise.resolve({ data: null, error: null }).then(resolve);
    }
  }

  return {
    from: vi.fn((table: string) => new Query(table)),
  };
}

function scriptedDb(results: QueryResult[]) {
  const calls: Array<{
    table: string;
    operation?: string;
    payload?: unknown;
  }> = [];
  const next = () =>
    Promise.resolve(results.shift() ?? { data: null, error: null });

  class Query {
    private readonly call: (typeof calls)[number];
    constructor(table: string) {
      this.call = { table };
      calls.push(this.call);
    }
    select() { this.call.operation ??= "select"; return this; }
    insert(payload: unknown) { this.call.operation = "insert"; this.call.payload = payload; return this; }
    update(payload: unknown) { this.call.operation = "update"; this.call.payload = payload; return this; }
    upsert(payload: unknown) { this.call.operation = "upsert"; this.call.payload = payload; return this; }
    delete() { this.call.operation = "delete"; return this; }
    eq() { return this; }
    is() { return this; }
    in() { return this; }
    not() { return this; }
    lt() { return this; }
    gte() { return this; }
    order() { return this; }
    limit() { return this; }
    single() { return next(); }
    maybeSingle() { return next(); }
    then(resolve: (result: QueryResult) => unknown) { return next().then(resolve); }
  }

  return {
    from: vi.fn((table: string) => new Query(table)),
    calls,
    remaining: results,
  };
}

const baseFile = {
  id: "22222222-2222-4222-8222-222222222222",
  session_id: "11111111-1111-4111-8111-111111111111",
  resource_id: "33333333-3333-4333-8333-333333333333",
  client_id: "client-1",
  filename: "contract.pdf",
  file_type: "pdf",
  content_type: "application/pdf",
  expected_size_bytes: 4,
  sealed_storage_path: "upload-sessions/user/session/file/sealed",
  target_folder_id: null,
  status: "uploaded",
  error_code: null,
};

const baseSession = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "44444444-4444-4444-8444-444444444444",
  purpose: "document_create" as const,
  destination: { scope: "standalone" },
  status: "processing",
};

describe("upload processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.recordAudit.mockResolvedValue(undefined);
  });

  it("creates a document and V1 from a sealed object without an HTTP upload body", async () => {
    const document = {
      id: baseFile.resource_id,
      user_id: baseSession.user_id,
      folder_id: null,
      library_folder_id: null,
    };
    const db = fakeDb({ documents: [{ data: document, error: null }] });

    const result = await processUploadFile(
      db as never,
      baseSession,
      baseFile,
    );

    expect(mocks.downloadFile).toHaveBeenCalledWith(baseFile.sealed_storage_path);
    expect(mocks.copyFile).toHaveBeenCalledWith(
      baseFile.sealed_storage_path,
      expect.stringContaining(baseFile.resource_id),
    );
    expect(db.from).toHaveBeenCalledWith("documents");
    expect(db.from).toHaveBeenCalledWith("document_versions");
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: "document.uploaded",
        documentId: baseFile.resource_id,
      }),
    );
    expect(result).toMatchObject({
      id: baseFile.resource_id,
      filename: "contract.pdf",
      active_version_number: 1,
    });
  });

  it("creates an idempotent workflow reference using its reserved resource id", async () => {
    const reference = {
      id: baseFile.resource_id,
      workflow_id: "55555555-5555-4555-8555-555555555555",
      filename: baseFile.filename,
    };
    const db = fakeDb({
      workflows: [
        { data: { id: reference.workflow_id, user_id: baseSession.user_id }, error: null },
      ],
      workflow_reference_documents: [{ data: reference, error: null }],
    });

    const result = await processUploadFile(
      db as never,
      {
        ...baseSession,
        purpose: "workflow_reference_create",
        destination: { workflow_id: reference.workflow_id },
      },
      baseFile,
    );

    expect(db.from).toHaveBeenCalledWith("workflow_reference_documents");
    expect(result).toEqual(reference);
    expect(mocks.copyFile).toHaveBeenCalledOnce();
  });

  it("creates a new document version from the sealed object", async () => {
    const createdVersion = {
      id: baseFile.resource_id,
      version_number: 3,
      source: "user_upload",
      filename: baseFile.filename,
    };
    const db = fakeDb({
      document_versions: [
        { data: null, error: null },
        { data: { version_number: 2 }, error: null },
        { data: createdVersion, error: null },
      ],
    });

    const result = await processUploadFile(
      db as never,
      {
        ...baseSession,
        purpose: "document_version_create",
        destination: {
          document_id: "55555555-5555-4555-8555-555555555555",
        },
      },
      baseFile,
    );

    expect(result).toEqual(createdVersion);
    expect(mocks.copyFile).toHaveBeenCalledWith(
      baseFile.sealed_storage_path,
      expect.stringContaining("55555555-5555-4555-8555-555555555555"),
    );
    expect(db.from).toHaveBeenCalledWith("documents");
  });

  it("replaces a document version and removes its obsolete object", async () => {
    const versionId = "55555555-5555-4555-8555-555555555555";
    const updatedVersion = {
      id: versionId,
      version_number: 2,
      source: "user_upload",
      filename: baseFile.filename,
    };
    const db = fakeDb({
      document_versions: [
        {
          data: {
            id: versionId,
            storage_path: "old/source.docx",
            pdf_storage_path: "old/rendition.pdf",
            version_number: 2,
            source: "user_upload",
          },
          error: null,
        },
        { data: updatedVersion, error: null },
      ],
    });

    const result = await processUploadFile(
      db as never,
      {
        ...baseSession,
        purpose: "document_version_replace",
        destination: {
          document_id: "66666666-6666-4666-8666-666666666666",
          version_id: versionId,
        },
      },
      { ...baseFile, filename: "replacement.pdf" },
    );

    expect(result).toEqual(updatedVersion);
    expect(mocks.deleteFile).toHaveBeenCalledWith("old/source.docx");
    expect(mocks.deleteFile).toHaveBeenCalledWith("old/rendition.pdf");
  });

  it("rejects a sealed object whose size no longer matches the reservation", async () => {
    mocks.downloadFile.mockResolvedValue(new Uint8Array([1, 2]).buffer);

    await expect(
      processUploadFile(fakeDb() as never, baseSession, baseFile),
    ).rejects.toThrow("sealed_upload_size_mismatch");
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("marks a failed created document and safely queues the job for retry", async () => {
    mocks.downloadFile.mockResolvedValue(null);
    const db = scriptedDb([
      {
        data: {
          id: "job-1",
          session_id: baseSession.id,
          attempts: 1,
          locked_by: "worker-1",
        },
        error: null,
      },
      { data: baseSession, error: null },
      { data: [baseFile], error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
      { error: null },
      { data: { id: "job-1" }, error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
    ]);

    await processUploadJob(db as never, "job-1", "worker-1");

    expect(db.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "documents",
          operation: "update",
          payload: expect.objectContaining({ status: "error" }),
        }),
        expect.objectContaining({
          table: "upload_processing_jobs",
          operation: "update",
          payload: expect.objectContaining({ status: "queued" }),
        }),
      ]),
    );
    expect(db.remaining).toHaveLength(0);
  });

  it("stops before processing when the database lease has been lost", async () => {
    const db = scriptedDb([
      {
        data: {
          id: "job-1",
          session_id: baseSession.id,
          attempts: 1,
          locked_by: "worker-1",
        },
        error: null,
      },
      { data: baseSession, error: null },
      { data: [baseFile], error: null },
      { data: null, error: null },
    ]);

    await expect(
      processUploadJob(db as never, "job-1", "worker-1"),
    ).rejects.toThrow("upload_job_lease_lost");
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("expires stale sessions, removes temporary objects, and deletes retained rows", async () => {
    const db = scriptedDb([
      { error: null },
      { error: null },
      {
        data: [{ id: "job-exhausted", session_id: "session-exhausted" }],
        error: null,
      },
      { error: null },
      { error: null },
      { data: [{ id: "session-clean" }], error: null },
      {
        data: [
          {
            staging_storage_path: "staging-object",
            sealed_storage_path: "sealed-object",
          },
        ],
        error: null,
      },
      { error: null },
      { data: [{ id: "old-session" }], error: null },
      { error: null },
    ]);

    await cleanupUploadSessions(db as never);

    expect(mocks.deleteFile).toHaveBeenCalledWith("staging-object");
    expect(mocks.deleteFile).toHaveBeenCalledWith("sealed-object");
    expect(db.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "upload_processing_jobs",
          operation: "update",
          payload: expect.objectContaining({ status: "error" }),
        }),
        expect.objectContaining({
          table: "upload_sessions",
          operation: "delete",
        }),
      ]),
    );
    expect(db.remaining).toHaveLength(0);
  });
});

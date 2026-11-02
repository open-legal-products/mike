import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticErrorTags } from "../../../lib/observability/sentryPrivacy";

const mocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  createFileReadStream: vi.fn(),
  copyFile: vi.fn(),
  officeFileToPdf: vi.fn(),
  recordAudit: vi.fn(),
  uploadFileFromPath: vi.fn(),
  createServerSupabase: vi.fn(),
  enqueueStorageCleanup: vi.fn(),
  requestDocumentCleanupDelivery: vi.fn(),
  reportError: vi.fn((_error: unknown, _context?: unknown) => null),
  setOperation: vi.fn(),
  markStage: vi.fn(),
}));

vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/observability/sentry")>()),
  reportError: mocks.reportError,
  setOperation: mocks.setOperation,
  markStage: mocks.markStage,
}));

vi.mock("../../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/storage")>();
  return {
    ...actual,
    deleteFile: mocks.deleteFile,
    // The best-effort wrapper resolves through the mocked delete so the
    // assertions on which objects were removed keep working.
    deleteFileBestEffort: (key: string) =>
      Promise.resolve(mocks.deleteFile(key)).catch(() => undefined),
    deleteFilesBestEffort: async (keys: Array<string | null | undefined>) => {
      for (const key of keys.filter(Boolean)) {
        await Promise.resolve(mocks.deleteFile(key)).catch(() => undefined);
      }
    },
    createFileReadStream: mocks.createFileReadStream,
    copyFile: mocks.copyFile,
    uploadFileFromPath: mocks.uploadFileFromPath,
  };
});

vi.mock("../../../lib/convert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/convert")>();
  return { ...actual, officeFileToPdf: mocks.officeFileToPdf };
});

vi.mock("../../../lib/audit", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("../../../lib/dbq/enqueue", () => ({
  enqueueStorageCleanup: mocks.enqueueStorageCleanup,
  requestDocumentCleanupDelivery: mocks.requestDocumentCleanupDelivery,
}));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: mocks.createServerSupabase,
}));

import {
  cleanupUploadProcessingTempFiles,
  cleanupUploadSessions,
  processUploadFile,
  processUploadJob,
  startUploadProcessingWorkers,
} from "../uploads.processing";

type QueryResult = { data?: unknown; error?: unknown };

function fakeDb(singleResults: Record<string, QueryResult[]> = {}) {
  class Query {
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    insert() {
      return this;
    }
    update() {
      return this;
    }
    upsert() {
      return this;
    }
    delete() {
      return this;
    }
    eq() {
      return this;
    }
    is() {
      return this;
    }
    in() {
      return this;
    }
    not() {
      return this;
    }
    lt() {
      return this;
    }
    gte() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      return Promise.resolve(
        singleResults[this.table]?.shift() ?? { data: null, error: null },
      );
    }
    maybeSingle() {
      return this.single();
    }
    then(resolve: (result: QueryResult) => unknown) {
      return Promise.resolve({ data: null, error: null }).then(resolve);
    }
  }

  return {
    from: vi.fn((table: string) => new Query(table)),
    rpc: vi.fn(async (name: string, args: { p_version?: Record<string, unknown> }): Promise<QueryResult> => name === "create_document_version"
      ? { data: { ...args.p_version, version_number: args.p_version?.version_number ?? 3 }, error: null }
      : { data: "processing", error: null }),
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
    select() {
      this.call.operation ??= "select";
      return this;
    }
    insert(payload: unknown) {
      this.call.operation = "insert";
      this.call.payload = payload;
      return this;
    }
    update(payload: unknown) {
      this.call.operation = "update";
      this.call.payload = payload;
      return this;
    }
    upsert(payload: unknown) {
      this.call.operation = "upsert";
      this.call.payload = payload;
      return this;
    }
    delete() {
      this.call.operation = "delete";
      return this;
    }
    eq() {
      return this;
    }
    is() {
      return this;
    }
    in() {
      return this;
    }
    not() {
      return this;
    }
    lt() {
      return this;
    }
    gte() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      return next();
    }
    maybeSingle() {
      return next();
    }
    then(resolve: (result: QueryResult) => unknown) {
      return next().then(resolve);
    }
  }

  return {
    from: vi.fn((table: string) => new Query(table)),
    rpc: vi.fn(async (name: string, args: { p_version?: Record<string, unknown> }): Promise<QueryResult> => name === "create_document_version"
      ? { data: { ...args.p_version, version_number: args.p_version?.version_number ?? 3 }, error: null }
      : { data: "processing", error: null }),
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
  document_created_at: null as string | null,
};

// A file row whose first attempt already wrote the destination document.
const createdFile = {
  ...baseFile,
  document_created_at: "2026-09-16T00:00:00.000Z",
};

const baseSession = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "44444444-4444-4444-8444-444444444444",
  user_email: "owner@example.com",
  purpose: "document_create" as const,
  destination: { scope: "standalone" },
  status: "processing",
};

describe("upload processing", () => {
  let processingTempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    processingTempRoot = await mkdtemp(join(tmpdir(), "mike-upload-test-"));
    process.env.UPLOAD_PROCESSING_TEMP_DIR = processingTempRoot;
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([Buffer.from([1, 2, 3, 4])]),
    );
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.officeFileToPdf.mockResolvedValue("/tmp/converted.pdf");
    mocks.uploadFileFromPath.mockResolvedValue(undefined);
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.recordAudit.mockResolvedValue(undefined);
    mocks.enqueueStorageCleanup.mockResolvedValue(undefined);
    mocks.requestDocumentCleanupDelivery.mockResolvedValue(0);
  });

  afterEach(async () => {
    expect(await readdir(processingTempRoot)).toEqual([]);
    await rm(processingTempRoot, { recursive: true, force: true });
    delete process.env.UPLOAD_PROCESSING_TEMP_DIR;
  });

  it("creates a document and V1 from a sealed object without an HTTP upload body", async () => {
    const document = {
      id: baseFile.resource_id,
      user_id: baseSession.user_id,
      folder_id: null,
      library_folder_id: null,
    };
    const db = fakeDb({ documents: [{ data: document, error: null }] });

    const result = await processUploadFile(db as never, baseSession, baseFile);

    expect(mocks.createFileReadStream).toHaveBeenCalledWith(
      baseFile.sealed_storage_path,
    );
    expect(mocks.copyFile).toHaveBeenCalledWith(
      baseFile.sealed_storage_path,
      expect.stringContaining(baseFile.resource_id),
    );
    expect(db.from).toHaveBeenCalledWith("documents");
    expect(db.rpc).toHaveBeenCalledWith("create_document_version", expect.objectContaining({ p_activate: true }));
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: "document.uploaded",
        documentId: baseFile.resource_id,
        userEmail: baseSession.user_email,
      }),
    );
    expect(result).toMatchObject({
      id: baseFile.resource_id,
      filename: "contract.pdf",
      active_version_number: 1,
    });
  });

  it("converts Office files from temporary paths and streams the PDF upload", async () => {
    const officeFile = {
      ...baseFile,
      filename: "contract.docx",
      file_type: "docx",
      content_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const document = {
      id: officeFile.resource_id,
      user_id: baseSession.user_id,
      folder_id: null,
      library_folder_id: null,
    };
    const db = fakeDb({ documents: [{ data: document, error: null }] });
    mocks.officeFileToPdf.mockImplementation(
      async (inputPath: string, outputDirectory: string) => {
        expect(inputPath).toBe(join(outputDirectory, "source.docx"));
        expect(await readFile(inputPath)).toEqual(Buffer.from([1, 2, 3, 4]));
        return join(outputDirectory, "source.pdf");
      },
    );

    await processUploadFile(db as never, baseSession, officeFile);

    expect(mocks.officeFileToPdf).toHaveBeenCalledOnce();
    expect(mocks.uploadFileFromPath).toHaveBeenCalledWith(
      expect.stringMatching(/^converted-pdfs\//),
      expect.stringMatching(/source\.pdf$/),
      "application/pdf",
    );
  });

  it("keeps the upload and reports a missing LibreOffice once, as a warning grouped by file type", async () => {
    // MIKE-BACKEND-9: the worker on a host without soffice.
    const officeFile = {
      ...baseFile,
      filename: "PRIVATE_NAME.docx",
      file_type: "docx",
      content_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const document = {
      id: officeFile.resource_id,
      user_id: baseSession.user_id,
      folder_id: null,
      library_folder_id: null,
    };
    const db = fakeDb({ documents: [{ data: document, error: null }] });
    mocks.officeFileToPdf.mockRejectedValue(
      Object.assign(new Error("LibreOffice (soffice) was not found"), {
        code: "conversion_unavailable",
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processUploadFile(db as never, baseSession, officeFile);

    expect(result).toMatchObject({ id: officeFile.resource_id });
    expect(mocks.uploadFileFromPath).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledOnce();
    const [error, context] = mocks.reportError.mock.calls[0]!;
    expect(diagnosticErrorTags(error)).toEqual({
      failure_code: "conversion_unavailable",
    });
    expect(context).toMatchObject({
      level: "warning",
      tags: { component: "upload-worker", stage: "conversion", file_type: "docx" },
      fingerprint: ["upload-conversion-failed", "docx"],
    });
    // Extension only: the filename never reaches the report.
    expect(JSON.stringify(context)).not.toContain("PRIVATE_NAME");
  });

  it("creates an idempotent workflow asset as a document using its reserved resource id", async () => {
    const asset = {
      id: baseFile.resource_id,
      workflow_id: "55555555-5555-4555-8555-555555555555",
      filename: baseFile.filename,
    };
    const db = fakeDb({
      documents: [{ data: asset, error: null }],
    });

    const result = await processUploadFile(
      db as never,
      {
        ...baseSession,
        purpose: "document_create",
        destination: { scope: "workflow", workflow_id: asset.workflow_id },
      },
      baseFile,
    );

    expect(db.from).toHaveBeenCalledWith("documents");
    expect(db.rpc).toHaveBeenCalledWith("create_document_version", expect.objectContaining({ p_activate: true }));
    expect(result).toMatchObject({
      id: asset.id,
      workflow_id: asset.workflow_id,
      filename: asset.filename,
    });
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

    expect(result).toMatchObject(createdVersion);
    expect(mocks.copyFile).toHaveBeenCalledWith(
      baseFile.sealed_storage_path,
      expect.stringContaining("55555555-5555-4555-8555-555555555555"),
    );
    expect(db.rpc).toHaveBeenCalledWith("create_document_version", expect.objectContaining({ p_document_id: "55555555-5555-4555-8555-555555555555" }));
  });

  it("replaces a document version; its trigger owns obsolete-object cleanup", async () => {
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
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("rejects a sealed object whose size no longer matches the reservation", async () => {
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([Buffer.from([1, 2])]),
    );

    await expect(
      processUploadFile(fakeDb() as never, baseSession, baseFile),
    ).rejects.toThrow("sealed_upload_size_mismatch");
    expect(mocks.uploadFileFromPath).not.toHaveBeenCalled();
  });

  it.each([false, undefined])("replaces DOCX bytes with generate_pdf=%s and invalidates obsolete renditions", async (generatePdf) => {
    const db = scriptedDb([
      { data: { id: "v", storage_path: "old/source.docx", pdf_storage_path: "old/rendition.pdf", content_sha256: "a".repeat(64) } },
      { data: { id: "v" } },
    ]);
    expect(await processUploadFile(db as never, {
      ...baseSession,
      purpose: "document_version_replace",
      destination: {
        document_id: "doc", version_id: "v", expected_content_sha256: "a".repeat(64),
        ...(generatePdf === undefined ? {} : { generate_pdf: generatePdf }),
      },
    }, { ...baseFile, filename: "edited.docx", file_type: "docx" })).toEqual({ id: "v" });

    expect(mocks.copyFile).toHaveBeenCalledOnce();
    expect(mocks.officeFileToPdf).toHaveBeenCalledTimes(generatePdf === false ? 0 : 1);
    expect(mocks.uploadFileFromPath).toHaveBeenCalledTimes(generatePdf === false ? 0 : 1);
    expect(db.calls).toContainEqual(expect.objectContaining({
      table: "document_versions", operation: "update",
      payload: expect.objectContaining({
        storage_path: expect.stringMatching(/\/versions\/[^/]+\.docx$/),
        filename: "edited.docx",
        content_sha256: createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex"),
        pdf_storage_path: generatePdf === false ? null : expect.stringContaining("converted-pdfs/"),
        page_count: null,
      }),
    }));
  });

  it("keeps a PDF source as its own rendition when generation is disabled", async () => {
    const db = scriptedDb([
      { data: { id: "v", storage_path: "old/source.pdf" } },
      { data: { id: "v" } },
    ]);
    await processUploadFile(db as never, {
      ...baseSession, purpose: "document_version_replace",
      destination: { document_id: "doc", version_id: "v", generate_pdf: false },
    }, baseFile);
    const patch = db.calls.find((call) => call.operation === "update")?.payload as Record<string, unknown>;
    expect(patch.pdf_storage_path).toBe(patch.storage_path);
    expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
  });

  it("rejects a stale editor save before copying any replacement bytes", async () => {
    const db = fakeDb({ document_versions: [{ data: { id: "v", storage_path: "old/key", content_sha256: "b".repeat(64) } }] });
    await expect(processUploadFile(db as never, {
      ...baseSession, purpose: "document_version_replace",
      destination: { document_id: "doc", version_id: "v", expected_content_sha256: "a".repeat(64) },
    }, baseFile)).rejects.toThrow("document_changed");
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("treats an already-committed editor save as a successful retry", async () => {
    const current = { id: "v", storage_path: "saved/key", content_sha256: createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex") };
    const db = fakeDb({ document_versions: [{ data: current }] });
    expect(await processUploadFile(db as never, {
      ...baseSession, purpose: "document_version_replace",
      destination: { document_id: "doc", version_id: "v", expected_content_sha256: "a".repeat(64) },
    }, baseFile)).toMatchObject({ id: "v" });
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("reports a concurrent update during conversion and records orphaned replacement objects", async () => {
    const db = fakeDb({ document_versions: [
      { data: { id: "v", storage_path: "old/key", content_sha256: "a".repeat(64) } },
      { data: null, error: null },
    ] });
    const thrown = await processUploadFile(db as never, {
      ...baseSession, purpose: "document_version_replace",
      destination: { document_id: "doc", version_id: "v", expected_content_sha256: "a".repeat(64) },
    }, baseFile).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ message: "document_changed", orphanedKeys: expect.arrayContaining([expect.stringContaining("doc")]) });
    // Named for Sentry: the kind, not the message, is what leaves the process.
    expect(diagnosticErrorTags(thrown)).toEqual({ error_kind: "upload.document_changed" });
  });

  it("hashes legacy stored bytes when the version has no recorded checksum", async () => {
    const db = fakeDb({ document_versions: [
      { data: { id: "v", storage_path: "old/key", content_sha256: null } },
      { data: { id: "v" } },
    ] });
    const expected = createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex");
    expect(await processUploadFile(db as never, {
      ...baseSession, purpose: "document_version_replace",
      destination: { document_id: "doc", version_id: "v", expected_content_sha256: expected },
    }, baseFile)).toEqual({ id: "v" });
    expect(mocks.createFileReadStream).toHaveBeenCalledWith("old/key");
  });

  // The upsert that makes a retry idempotent is also what brings a document
  // the user deleted mid-processing back from the dead. Only a row this
  // upload already wrote (marker set) can have been deleted.
  it("refuses to recreate a document deleted while the upload was processing", async () => {
    const db = scriptedDb([{ data: null, error: null }]);

    const thrown = await processUploadFile(
      db as never,
      baseSession,
      createdFile,
    ).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ message: expect.stringMatching(/document_deleted/) });
    expect(diagnosticErrorTags(thrown)).toEqual({ error_kind: "upload.document_deleted" });

    expect(db.calls.some((call) => call.operation === "upsert")).toBe(false);
    expect(db.rpc).not.toHaveBeenCalled();
    // Nothing was written to the destination either.
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("stops when the destination vanishes between the copy and the version insert", async () => {
    const db = fakeDb();
    db.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "document_not_found" },
    } as never);

    await expect(
      processUploadFile(db as never, baseSession, baseFile),
    ).rejects.toThrow(/document_deleted/);
  });

  // The other half of the same race, which the attempt counter got wrong: a
  // first attempt that failed BEFORE the row existed (storage read, org
  // lookup, the upsert itself) leaves nothing to delete. The retry must
  // create the document, not report it deleted and give up.
  it("creates the document on a retry whose first attempt never wrote the row", async () => {
    const document = {
      id: baseFile.resource_id,
      user_id: baseSession.user_id,
      folder_id: null,
      library_folder_id: null,
    };
    // No marker on the file row, and no documents row either: the lookup
    // must not even be consulted, so the only scripted `documents` result is
    // the post-upsert update.
    const db = fakeDb({ documents: [{ data: document, error: null }] });

    const result = await processUploadFile(db as never, baseSession, {
      ...baseFile,
      document_created_at: null,
    });

    expect(result).toMatchObject({ id: baseFile.resource_id });
    // The row was written, and the marker recorded so the NEXT retry checks
    // for deletion instead of recreating.
    expect(db.from).toHaveBeenCalledWith("documents");
    expect(db.from).toHaveBeenCalledWith("upload_session_files");
    expect(mocks.enqueueStorageCleanup).not.toHaveBeenCalled();
  });

  it("stamps the marker only after the documents upsert succeeded", async () => {
    const db = scriptedDb([
      // documents.upsert fails (transient database error).
      { error: { code: "57P01", message: "terminating connection" } },
    ]);

    await expect(
      processUploadFile(db as never, baseSession, baseFile),
    ).rejects.toMatchObject({ code: "57P01" });

    const stamped = db.calls.some(
      (call) =>
        call.table === "upload_session_files" &&
        call.operation === "update" &&
        "document_created_at" in ((call.payload as object) ?? {}),
    );
    expect(stamped).toBe(false);
  });

  it("names a sealed object the store cannot serve as upload.sealed_missing", async () => {
    const { StorageOperationError } = await import("../../../lib/storage.js");
    const storageError = new StorageOperationError("download", {
      cause: Object.assign(new Error("gone"), { name: "NoSuchKey" }),
    });
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from(
        (async function* () {
          throw storageError;
        })(),
      ),
    );
    const db = fakeDb();

    const thrown = await processUploadFile(db as never, baseSession, baseFile)
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({ message: "sealed_upload_not_found", kind: "upload.sealed_missing", cause: storageError });
    // The deepest kind on the chain is the one reported: the store's own
    // answer, with its code; the wrapper's kind stays on the thrown object.
    expect(diagnosticErrorTags(thrown)).toEqual({
      error_kind: "storage.download_failed",
      storage_operation: "download",
      failure_code: "NoSuchKey",
    });
  });

  it("marks a failed created document and safely queues the job for retry", async () => {
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from(
        (async function* () {
          throw new Error("sealed object unavailable");
        })(),
      ),
    );
    const db = scriptedDb([
      {
        data: {
          id: "job-1",
          session_id: baseSession.id,
          file_id: baseFile.id,
          attempts: 1,
          locked_by: "worker-1",
        },
        error: null,
      },
      { data: baseSession, error: null },
      { data: baseFile, error: null },
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

    // The job names its flow once and marks the stages it passes, so the
    // failure above arrives in Sentry under documents.upload.complete with
    // the path it took (claimed, then failed inside process-file).
    expect(mocks.setOperation).toHaveBeenCalledWith("documents.upload.complete");
    expect(mocks.markStage.mock.calls.map(([stage]) => stage)).toEqual([
      "claim",
      "process-file",
    ]);

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
        expect.objectContaining({
          table: "upload_session_files",
          operation: "update",
          payload: expect.objectContaining({ status: "uploaded" }),
        }),
      ]),
    );
    expect(db.remaining).toHaveLength(0);
  });

  // The measured resurrection: the job failed on P0002, retried, and the
  // retry's upsert put the document back with status ready and its object
  // live. A vanished destination has to end the job, not restart it.
  it("does not retry a job whose destination document was deleted", async () => {
    const db = scriptedDb([
      {
        data: {
          id: "job-1",
          session_id: baseSession.id,
          file_id: baseFile.id,
          // A retry: the first attempt is what the user deleted under.
          attempts: 2,
          locked_by: "worker-1",
        },
        error: null,
      },
      { data: baseSession, error: null },
      // The first attempt wrote the row before the user deleted it.
      { data: createdFile, error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
      // The destination document lookup: gone.
      { data: null, error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
      { error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
      { data: null, error: null },
      { data: { id: "job-1" }, error: null },
    ]);

    await processUploadJob(db as never, "job-1", "worker-1");

    expect(db.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "upload_session_files",
          operation: "update",
          payload: expect.objectContaining({ error_code: "document_deleted" }),
        }),
      ]),
    );
    // No requeue: the job finishes as a partial failure instead.
    expect(
      db.calls.some(
        (call) =>
          call.table === "upload_processing_jobs" &&
          (call.payload as { status?: string } | undefined)?.status === "queued",
      ),
    ).toBe(false);
    // The bytes this upload wrote have no row pointing at them now.
    expect(mocks.enqueueStorageCleanup).toHaveBeenCalledWith(
      db,
      expect.arrayContaining([expect.stringContaining(baseFile.resource_id)]),
    );
  });

  it("names a job, session or file row that is no longer there (MIKE-BACKEND-M)", async () => {
    const job = {
      id: "job-1",
      session_id: baseSession.id,
      file_id: baseFile.id,
      attempts: 1,
      locked_by: "worker-1",
    };
    const cases: Array<{ results: QueryResult[]; kind: string; message: string }> = [
      { results: [{ data: null, error: null }], kind: "upload.job_missing", message: "upload_job_not_found" },
      {
        results: [{ data: job, error: null }, { data: null, error: null }],
        kind: "upload.session_missing",
        message: "upload_session_not_found",
      },
      {
        results: [{ data: job, error: null }, { data: baseSession, error: null }, { data: null, error: null }],
        kind: "upload.file_missing",
        message: "upload_session_file_not_found",
      },
    ];
    for (const { results, kind, message } of cases) {
      const db = scriptedDb(results);
      const thrown = await processUploadJob(db as never, "job-1", "worker-1").then(
        () => null,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(message);
      expect(diagnosticErrorTags(thrown).error_kind).toBe(kind);
    }
    expect(mocks.createFileReadStream).not.toHaveBeenCalled();
  });

  it("keeps a database failure on the lookup as the failure, with its code", async () => {
    const db = scriptedDb([{ data: null, error: { code: "57014", message: "canceling statement" } }]);
    const thrown = await processUploadJob(db as never, "job-1", "worker-1").then(
      () => null,
      (error: unknown) => error,
    );
    expect(diagnosticErrorTags(thrown).failure_code).toBe("57014");
    expect(diagnosticErrorTags(thrown).error_kind).toBeUndefined();
  });

  it("stops before processing when the database lease has been lost", async () => {
    const db = scriptedDb([
      {
        data: {
          id: "job-1",
          session_id: baseSession.id,
          file_id: baseFile.id,
          attempts: 1,
          locked_by: "worker-1",
        },
        error: null,
      },
      { data: baseSession, error: null },
      { data: baseFile, error: null },
      { data: null, error: null },
    ]);

    await expect(
      processUploadJob(db as never, "job-1", "worker-1"),
    ).rejects.toThrow("upload_job_lease_lost");
    expect(mocks.createFileReadStream).not.toHaveBeenCalled();
  });

  it("reports an editor conflict as terminal instead of retrying an overwrite", async () => {
    const db = scriptedDb([
      { data: { id: "job-1", session_id: baseSession.id, file_id: baseFile.id, attempts: 1, locked_by: "worker-1" } },
      { data: { ...baseSession, purpose: "document_version_replace", destination: { document_id: "doc", version_id: "v", expected_content_sha256: "a".repeat(64) } } },
      { data: baseFile },
      { data: { id: "job-1" } },
      { error: null },
      { data: { id: "v", storage_path: "old/key", content_sha256: "b".repeat(64) } },
      { data: { id: "job-1" } },
      { error: null },
      { data: { id: "job-1" } },
      { data: [] },
      { data: { id: "job-1" } },
    ]);
    await processUploadJob(db as never, "job-1", "worker-1");
    expect(db.calls).toContainEqual(expect.objectContaining({ table: "upload_session_files", operation: "update", payload: expect.objectContaining({ error_code: "document_changed" }) }));
    expect(db.calls.some((call) => call.table === "upload_processing_jobs" && (call.payload as { status?: string })?.status === "queued")).toBe(false);
    expect(db.remaining).toHaveLength(0);
  });

  it("removes stale temporary upload directories left by an interrupted worker", async () => {
    const staleDirectory = join(processingTempRoot, "mike-upload-stale");
    await mkdir(staleDirectory);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(staleDirectory, twoHoursAgo, twoHoursAgo);

    await cleanupUploadProcessingTempFiles();

    expect(await readdir(processingTempRoot)).toEqual([]);
  });

  it("starts the configured number of claim loops with the per-user cap", async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    db.rpc.mockResolvedValue({ data: null, error: null });
    mocks.createServerSupabase.mockReturnValue(db);

    const stop = startUploadProcessingWorkers({
      concurrency: 16,
      maxRunningPerUser: 4,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => {
        expect(
          db.rpc.mock.calls.filter(
            ([name]) => name === "claim_upload_processing_job",
          ),
        ).toHaveLength(16);
      });
      const claimCalls = db.rpc.mock.calls.filter(
        ([name]) => name === "claim_upload_processing_job",
      );
      expect(claimCalls).toEqual(
        expect.arrayContaining([
          [
            "claim_upload_processing_job",
            expect.objectContaining({ target_max_running_per_user: 4 }),
          ],
        ]),
      );
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("reports a claim loop that fails every tick once, with its code, and backs off (MIKE-BACKEND-K)", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const missingRpc = {
      code: "PGRST202",
      message: "Could not find the function public.claim_upload_processing_job",
      details: null,
      hint: null,
    };
    let claimError: typeof missingRpc | null = missingRpc;
    const db = fakeDb();
    db.rpc.mockImplementation(async (name: string) =>
      name === "claim_upload_processing_job" && claimError
        ? { data: null, error: claimError }
        : { data: null, error: null },
    );
    mocks.createServerSupabase.mockReturnValue(db);
    const claims = () =>
      db.rpc.mock.calls.filter(([name]) => name === "claim_upload_processing_job")
        .length;
    const reports = () =>
      mocks.reportError.mock.calls.filter(
        ([, context]) =>
          (context as { tags?: { component?: string } } | undefined)?.tags
            ?.component === "upload-worker",
      );

    const stop = startUploadProcessingWorkers({
      concurrency: 2,
      maxRunningPerUser: 1,
    });
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      // One report for the process, not one per tick per loop (~600).
      expect(reports()).toHaveLength(1);
      const [reported] = reports()[0];
      expect(reported).toBeInstanceOf(Error);
      expect(diagnosticErrorTags(reported).failure_code).toBe("PGRST202");
      // The console copy carries the same object, so the bridge dedupes it.
      const logged = consoleError.mock.calls.filter(
        ([label]) => label === "[upload-worker] iteration failed",
      );
      expect(logged).toHaveLength(1);
      expect((logged[0][1] as { error: unknown }).error).toBe(reported);
      // Backed off to the 30 s ceiling instead of polling every second.
      expect(claims()).toBeLessThan(40);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[upload-worker\] iteration still failing \(Error:PGRST202\)/),
      );

      claimError = null;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(consoleLog).toHaveBeenCalledWith(
        expect.stringMatching(/^\[upload-worker\] iteration recovered after \d+ consecutive failure/),
      );

      // The same failure returning minutes after it was reported is a flap,
      // not news: one event per class per window, however often it recurs.
      claimError = missingRpc;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reports()).toHaveLength(1);
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[upload-worker\] iteration failing again \(Error:PGRST202\)/),
      );

      // A different failure class is reported at once.
      claimError = null;
      await vi.advanceTimersByTimeAsync(31_000);
      claimError = { ...missingRpc, code: "40P01", message: "deadlock detected" };
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reports()).toHaveLength(2);
      expect(diagnosticErrorTags(reports()[1][0]).failure_code).toBe("40P01");
    } finally {
      stop();
      vi.useRealTimers();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it("expires stale sessions, removes temporary objects, and deletes retained rows", async () => {
    const db = scriptedDb([
      { error: null },
      { error: null },
      {
        data: [
          {
            id: "job-exhausted",
            session_id: "session-exhausted",
            file_id: "file-exhausted",
          },
        ],
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

  // A document uploaded on its own is filed under the workspace its session
  // named; inside a project or a workflow, that decides.
  describe("the organization a new document is filed under", () => {
    const ORG = "66666666-6666-4666-8666-666666666666";
    /** The row written to `documents` while one file is processed. */
    async function documentRowFor(destination: Record<string, unknown>) {
      const document = {
        id: baseFile.resource_id,
        user_id: baseSession.user_id,
        folder_id: null,
        library_folder_id: null,
      };
      const db = fakeDb({ documents: [{ data: document, error: null }] });
      const rows: Record<string, unknown>[] = [];
      const from = db.from;
      db.from = vi.fn((table: string) => {
        const query = from(table);
        if (table === "documents") {
          const upsert = query.upsert.bind(query);
          query.upsert = (...args: unknown[]) => {
            rows.push(args[0] as Record<string, unknown>);
            return (upsert as (...a: unknown[]) => typeof query)(...args);
          };
        }
        return query;
      }) as typeof db.from;
      await processUploadFile(
        db as never,
        { ...baseSession, destination } as never,
        baseFile,
      );
      expect(rows).toHaveLength(1);
      return rows[0];
    }

    it.each([
      ["a standalone upload", { scope: "standalone", org_id: ORG }],
      ["a library upload", { scope: "library", library_kind: "file", org_id: ORG }],
    ])("is the workspace named by %s", async (_label, destination) => {
      expect(await documentRowFor(destination)).toMatchObject({
        org_id: ORG,
        project_id: null,
      });
    });

    it("is none — Personal — when the upload names no organization", async () => {
      expect(await documentRowFor({ scope: "standalone" })).toMatchObject({
        org_id: null,
      });
    });
  });
});

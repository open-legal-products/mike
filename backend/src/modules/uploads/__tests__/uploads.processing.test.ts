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
import JSZip from "jszip";
import { Document, Packer, Paragraph } from "docx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_SIZE_BYTES } from "../uploads.manifest";
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
}));

vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/observability/sentry")>()),
  reportError: mocks.reportError,
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

function withDeclaredZipEntrySize(
  bytes: Buffer,
  entryName: string,
  declaredSize: number,
): Buffer {
  const result = Buffer.from(bytes);
  const nameBytes = Buffer.from(entryName);
  let nameOffset = 0;
  while ((nameOffset = result.indexOf(nameBytes, nameOffset)) !== -1) {
    const centralDirectoryOffset = nameOffset - 46;
    if (
      centralDirectoryOffset >= 0 &&
      result.readUInt32LE(centralDirectoryOffset) === 0x02014b50 &&
      result.readUInt16LE(centralDirectoryOffset + 28) === nameBytes.length
    ) {
      result.writeUInt32LE(declaredSize, centralDirectoryOffset + 24);
      return result;
    }
    nameOffset += nameBytes.length;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

async function minimalDocxBytes(
  contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>
</w:document>`,
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

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
    const officeBytes = await minimalDocxBytes();
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([officeBytes]),
    );
    const officeFile = {
      ...baseFile,
      filename: "contract.docx",
      file_type: "docx",
      content_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      expected_size_bytes: officeBytes.length,
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
        expect(await readFile(inputPath)).toEqual(officeBytes);
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

  it("rejects a .docx upload that is a ZIP but not a Word package", async () => {
    const zip = new JSZip();
    zip.file("not-word.txt", "hello");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([bytes]),
    );

    const db = fakeDb();
    await expect(
      processUploadFile(db as never, baseSession, {
        ...baseFile,
        filename: "fake.docx",
        file_type: "docx",
        content_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        expected_size_bytes: bytes.length,
      }),
    ).rejects.toThrow("invalid_docx_package");

    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("rejects a DOCX whose package relationship points at another part", async () => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    const relationships = await zip.file("_rels/.rels")!.async("string");
    zip.file("_rels/.rels", relationships.replace('Target="word/document.xml"', 'Target="word/other.xml"'));
    zip.file("word/other.xml", "not a Word document");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile,
      filename: "fake.docx",
      file_type: "docx",
      expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("rejects a DOCX whose main part is not WordprocessingML", async () => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    zip.file("word/document.xml", '<document xmlns="urn:not-word"><body/></document>');
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile,
      filename: "fake.docx",
      file_type: "docx",
      expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it.each([
    ["no office-document relationship", (xml: string) => xml.replace(/<Relationship Id[^>]+\/>/, "")],
    ["wrong relationship type", (xml: string) => xml.replace(/\/officeDocument"/, '/image"')],
    ["external main relationship", (xml: string) => xml.replace('Target="', 'TargetMode="External" Target="')],
    ["external URL", (xml: string) => xml.replace('Target="word/', 'Target="https://example.invalid/word/')],
    ["network-path target", (xml: string) => xml.replace('Target="word/', 'Target="//docx.invalid/word/')],
    ["whitespace-prefixed network target", (xml: string) => xml.replace('Target="word/', 'Target=" //docx.invalid/word/')],
    ["backslash target", (xml: string) => xml.replace('word/document.xml"', 'word\\\\document.xml"')],
    ["unknown target mode", (xml: string) => xml.replace('Target="', 'TargetMode="Other" Target="')],
    ["missing target", (xml: string) => xml.replace('Target="word/document.xml"', "")],
    ["fragment target", (xml: string) => xml.replace('word/document.xml"', 'word/document.xml#part"')],
    ["wrong package namespace", (xml: string) => xml.replace('package/2006/relationships', 'package/2006/not-relationships')],
    ["extra colon in relationships root QName", (xml: string) => xml.replace(/Relationships/g, 'r:Relationships:extra').replace(/<Relationship /g, '<r:Relationship ').replace('xmlns=', 'xmlns:r=')],
    ["extra colon in relationship QName", (xml: string) => xml.replace(/Relationships/g, 'r:Relationships').replace(/<Relationship /g, '<r:Relationship:extra ').replace('xmlns=', 'xmlns:r=')],
    ["duplicate main relationships", (xml: string) => xml.replace(/(<Relationship Id[^>]+\/>)/, '$1$1')],
    ["malformed relationships XML", (xml: string) => xml.replace('</Relationships>', '')],
    ["entity declaration", (xml: string) => '<!DOCTYPE Relationships [<!ENTITY target SYSTEM "https://example.invalid/word/document.xml">]>' + xml.replace(/<\?xml[^>]+\?>/, '')],
  ])("rejects DOCX package XML with %s", async (_name, change) => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    zip.file("_rels/.rels", change(await zip.file("_rels/.rels")!.async("string")));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it.each(["word/document.xml", "_rels/.rels", "[Content_Types].xml"])(
    "accepts whitespace before a processing instruction in %s",
    async (part) => {
      const zip = await JSZip.loadAsync(await minimalDocxBytes());
      const xml = await zip.file(part)!.async("string");
      zip.file(part, xml.replace("?>", '?>\n \t<?mso-application progid="Word.Document"?>'));
      const bytes = await zip.generateAsync({ type: "nodebuffer" });
      mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
      const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

      await expect(processUploadFile(db as never, baseSession, {
        ...baseFile, filename: "valid.docx", file_type: "docx", expected_size_bytes: bytes.length,
      })).resolves.toMatchObject({ id: baseFile.resource_id });
      expect(mocks.copyFile).toHaveBeenCalledOnce();
      expect(mocks.officeFileToPdf).toHaveBeenCalledOnce();
      expect(db.rpc).toHaveBeenCalledWith("create_document_version", expect.objectContaining({ p_activate: true }));
      expect(await readdir(processingTempRoot)).toEqual([]);
    },
  );

  it.each([
    ["word/document.xml", "non-whitespace top-level text"],
    ["_rels/.rels", "non-whitespace top-level text"],
    ["[Content_Types].xml", "non-whitespace top-level text"],
    ["word/document.xml", "multiple roots"],
    ["_rels/.rels", "multiple roots"],
    ["[Content_Types].xml", "multiple roots"],
  ])("rejects %s with %s before a processing instruction", async (part, invalid) => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    const xml = await zip.file(part)!.async("string");
    const extra = invalid === "multiple roots" ? "<extra/>" : "not-whitespace";
    zip.file(part, xml.replace("?>", `?>\n${extra}\n<?mso-application progid="Word.Document"?>`));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb();

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(await readdir(processingTempRoot)).toEqual([]);
  });

  it.each([
    ["word/document.xml", "w:document"],
    ["word/document.xml", "w:body"],
    ["_rels/.rels", "Relationships"],
    ["_rels/.rels", "Relationship"],
    ["[Content_Types].xml", "Types"],
    ["[Content_Types].xml", "Override"],
  ])("rejects whitespace-padded namespace on %s %s", async (part, element) => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    const xml = await zip.file(part)!.async("string");
    const declaration = xml.match(/xmlns(?::w)?="([^"]+)"/)![0];
    const paddedDeclaration = declaration.replace('="', '=" ').replace(/"$/, ' "');
    const isRoot = ["w:document", "Relationships", "Types"].includes(element);
    zip.file(part, isRoot
      ? xml.replace(declaration, paddedDeclaration)
      : xml.replace(new RegExp(`<${element}(?=[\\s>])`), `<${element} ${paddedDeclaration}`));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
    expect(await readdir(processingTempRoot)).toEqual([]);
  });

  it.each([
    ["plain text", "not XML"],
    ["empty main part", ""],
    ["malformed main XML", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:document>'],
    ["wrong main root", '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:styles>'],
    ["extra colon in document QName", '<w:document:extra xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document:extra>'],
    ["extra colon in body QName", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body:extra/></w:document>'],
    ["missing body", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'],
    ["wrong body namespace", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body xmlns:w="urn:not-word"/></w:document>'],
    ["duplicate document roots", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'.repeat(2)],
    ["duplicate bodies", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/><w:body/></w:document>'],
    ["main XML DTD", '<!DOCTYPE document SYSTEM "https://example.invalid/word.dtd"><document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body/></document>'],
  ])("rejects DOCX main XML with %s", async (_name, xml) => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    zip.file("word/document.xml", xml);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.officeFileToPdf).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it.each([
    ["default namespace and empty body", '<document xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body/></document>'],
    ["alternate prefixes", '<word:document xmlns:word="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:b="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><b:body/></word:document>'],
    ["strict namespace", '<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body/></w:document>'],
    ["main XML larger than metadata ceiling", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + 'a'.repeat(256 * 1024 + 1) + '</w:t></w:r></w:p></w:body></w:document>'],
  ])("accepts valid DOCX with %s", async (_name, xml) => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    zip.file("word/document.xml", xml);
    const relationships = await zip.file("_rels/.rels")!.async("string");
    zip.file("_rels/.rels", relationships
      .replace(/Relationships/g, 'r:Relationships')
      .replace(/<Relationship /g, '<r:Relationship ')
      .replace('xmlns=', 'xmlns:r=')
      .replace(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
        _name === "strict namespace"
          ? 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'
          : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
      )
      .replace('Target="word/', 'TargetMode="Internal" Target="/word/'));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "valid.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).resolves.toMatchObject({ id: baseFile.resource_id });
    expect(mocks.copyFile).toHaveBeenCalledOnce();
    expect(mocks.officeFileToPdf).toHaveBeenCalledOnce();
  });

  it.each([
    ["_rels/.rels", 256 * 1024],
    ["word/document.xml", MAX_UPLOAD_SIZE_BYTES],
  ])("rejects %s with a declared size above its ceiling", async (part, limit) => {
    const bytes = withDeclaredZipEntrySize(await minimalDocxBytes(), part, limit + 1);
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));

    await expect(processUploadFile(fakeDb() as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it.each([
    ["_rels/.rels", 256 * 1024],
    ["word/document.xml", MAX_UPLOAD_SIZE_BYTES],
  ])("rejects %s whose actual decompressed bytes exceed its ceiling", async (part, limit) => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    zip.file(part, Buffer.alloc(limit + 1, " "));
    const bytes = withDeclaredZipEntrySize(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), part, 1,
    );
    expect(bytes.length).toBeLessThan(MAX_UPLOAD_SIZE_BYTES);
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));

    await expect(processUploadFile(fakeDb() as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects invalid UTF-8 in the main XML", async () => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", Buffer.concat([
      Buffer.from(xml.slice(0, xml.indexOf("Hello"))),
      Buffer.from([0xff]),
      Buffer.from(xml.slice(xml.indexOf("Hello") + "Hello".length)),
    ]));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it.each(["utf16le", "utf16be"])("accepts a UTF-16 main document (%s)", async (encoding) => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    const xml = (await zip.file("word/document.xml")!.async("string"))
      .replace('encoding="UTF-8"', 'encoding="UTF-16"');
    const encoded = Buffer.from('\uFEFF' + xml, "utf16le");
    zip.file("word/document.xml", encoding === "utf16be" ? encoded.swap16() : encoded);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "valid.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).resolves.toMatchObject({ id: baseFile.resource_id });
  });

  it("accepts a DOCX generated by the existing document library", async () => {
    const bytes = await Packer.toBuffer(new Document({
      sections: [{ children: [new Paragraph("Hello")] }],
    }));
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "generated.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).resolves.toMatchObject({ id: baseFile.resource_id });
    expect(mocks.copyFile).toHaveBeenCalledOnce();
    expect(mocks.officeFileToPdf).toHaveBeenCalledOnce();
  });

  it.each(["_rels/.rels", "word/document.xml"])("rejects %s with forged decompressed size metadata", async (part) => {
    const bytes = withDeclaredZipEntrySize(await minimalDocxBytes(), part, 1);
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));

    await expect(processUploadFile(fakeDb() as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("rejects an oversized sealed DOCX before ZIP parsing", async () => {
    const loadZip = vi.spyOn(JSZip, "loadAsync");
    const bytes = Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1);
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    try {
      await expect(processUploadFile(fakeDb() as never, baseSession, {
        ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
      })).rejects.toThrow("invalid_docx_package");
      expect(loadZip).not.toHaveBeenCalled();
      expect(mocks.copyFile).not.toHaveBeenCalled();
    } finally {
      loadZip.mockRestore();
    }
  });

  it.each([
    ["prefixed root and override", '<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types"><ct:Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></ct:Types>'],
    ["different override prefix", '<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types"><part:Override xmlns:part="http://schemas.openxmlformats.org/package/2006/content-types" PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></ct:Types>'],
    ["Unicode prefixes", '<型:Types xmlns:型="http://schemas.openxmlformats.org/package/2006/content-types"><型:Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></型:Types>'],
  ])("accepts DOCX content-types with %s", async (_name, xml) => {
    const bytes = await minimalDocxBytes(xml);
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "valid.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).resolves.toMatchObject({ id: baseFile.resource_id });
    expect(mocks.copyFile).toHaveBeenCalledOnce();
    expect(mocks.officeFileToPdf).toHaveBeenCalledOnce();
  });

  it("rejects malformed content-types XML", async () => {
    const zip = await JSZip.loadAsync(await minimalDocxBytes());
    const contentTypes = await zip.file("[Content_Types].xml")!.async("string");
    zip.file("[Content_Types].xml", contentTypes.replace('</Types>', ''));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() => Readable.from([bytes]));
    const db = fakeDb({ documents: [{ data: { id: baseFile.resource_id }, error: null }] });

    await expect(processUploadFile(db as never, baseSession, {
      ...baseFile, filename: "fake.docx", file_type: "docx", expected_size_bytes: bytes.length,
    })).rejects.toThrow("invalid_docx_package");
  });

  it("rejects a .docx upload whose content type is not assigned to word/document.xml", async () => {
    const bytes = await minimalDocxBytes(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <!-- application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml -->
</Types>`,
    );
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([bytes]),
    );

    await expect(
      processUploadFile(fakeDb() as never, baseSession, {
        ...baseFile,
        filename: "fake.docx",
        file_type: "docx",
        content_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        expected_size_bytes: bytes.length,
      }),
    ).rejects.toThrow("invalid_docx_package");

    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("rejects a .docx upload with an oversized content-types part", async () => {
    const bytes = await minimalDocxBytes("x".repeat(256 * 1024 + 1));
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([bytes]),
    );

    await expect(
      processUploadFile(fakeDb() as never, baseSession, {
        ...baseFile,
        filename: "fake.docx",
        file_type: "docx",
        content_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        expected_size_bytes: bytes.length,
      }),
    ).rejects.toThrow("invalid_docx_package");

    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("rejects an oversized DOCX XML entry when ZIP metadata understates its size", async () => {
    const generated = await minimalDocxBytes("x".repeat(256 * 1024 + 1));
    const bytes = withDeclaredZipEntrySize(
      generated,
      "[Content_Types].xml",
      1,
    );
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([bytes]),
    );

    await expect(
      processUploadFile(fakeDb() as never, baseSession, {
        ...baseFile,
        filename: "fake.docx",
        file_type: "docx",
        content_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        expected_size_bytes: bytes.length,
      }),
    ).rejects.toThrow("invalid_docx_package");

    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("keeps the upload and reports a missing LibreOffice once, as a warning grouped by file type", async () => {
    // MIKE-BACKEND-9: the worker on a host without soffice.
    const officeBytes = await minimalDocxBytes();
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([officeBytes]),
    );
    const officeFile = {
      ...baseFile,
      filename: "PRIVATE_NAME.docx",
      file_type: "docx",
      content_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      expected_size_bytes: officeBytes.length,
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
    const officeBytes = await minimalDocxBytes();
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([officeBytes]),
    );
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
    }, {
      ...baseFile,
      filename: "edited.docx",
      file_type: "docx",
      expected_size_bytes: officeBytes.length,
    })).toEqual({ id: "v" });

    expect(mocks.copyFile).toHaveBeenCalledOnce();
    expect(mocks.officeFileToPdf).toHaveBeenCalledTimes(generatePdf === false ? 0 : 1);
    expect(mocks.uploadFileFromPath).toHaveBeenCalledTimes(generatePdf === false ? 0 : 1);
    expect(db.calls).toContainEqual(expect.objectContaining({
      table: "document_versions", operation: "update",
      payload: expect.objectContaining({
        storage_path: expect.stringMatching(/\/versions\/[^/]+\.docx$/),
        filename: "edited.docx",
        content_sha256: createHash("sha256").update(officeBytes).digest("hex"),
        pdf_storage_path: generatePdf === false ? null : expect.stringContaining("converted-pdfs/"),
        page_count: null,
        textless_page_count: null,
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
    await expect(processUploadFile(db as never, {
      ...baseSession, purpose: "document_version_replace",
      destination: { document_id: "doc", version_id: "v", expected_content_sha256: "a".repeat(64) },
    }, baseFile)).rejects.toMatchObject({ message: "document_changed", orphanedKeys: expect.arrayContaining([expect.stringContaining("doc")]) });
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

    await expect(
      processUploadFile(db as never, baseSession, createdFile),
    ).rejects.toThrow(/document_deleted/);

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

  it("marks an invalid DOCX package as terminal and does not requeue the job", async () => {
    const zip = new JSZip();
    zip.file("not-word.txt", "hello");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([bytes]),
    );
    const invalidDocxFile = {
      ...baseFile,
      filename: "fake.docx",
      file_type: "docx",
      content_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      expected_size_bytes: bytes.length,
    };
    const db = scriptedDb([
      { data: { id: "job-1", session_id: baseSession.id, file_id: baseFile.id, attempts: 1, locked_by: "worker-1" } },
      { data: baseSession, error: null },
      { data: invalidDocxFile, error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
      { error: null },
      { data: { id: "job-1" }, error: null },
      { error: null },
      { data: [], error: null },
      { data: { id: "job-1" }, error: null },
    ]);

    await processUploadJob(db as never, "job-1", "worker-1");

    expect(db.calls).toContainEqual(expect.objectContaining({
      table: "upload_session_files",
      operation: "update",
      payload: expect.objectContaining({
        status: "error",
        error_code: "invalid_docx_package",
      }),
    }));
    expect(db.calls.some((call) => call.table === "upload_processing_jobs" && (call.payload as { status?: string })?.status === "queued")).toBe(false);
    expect(mocks.reportError).not.toHaveBeenCalled();
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

      claimError = missingRpc;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reports()).toHaveLength(2);
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

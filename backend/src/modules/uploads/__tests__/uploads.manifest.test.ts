import { describe, expect, it } from "vitest";

import { AppError } from "../../../lib/appError";
import { diagnosticErrorTags } from "../../../lib/observability/sentryPrivacy";
import {
  MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SESSION_FILES,
  MAX_UPLOAD_SESSION_TOTAL_BYTES,
  parseUploadSessionRequest,
  UploadSessionValidationError,
} from "../uploads.manifest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function documentRequest(fileCount: number, sizeBytes = 1024) {
  return {
    purpose: "document_create",
    destination: { scope: "standalone" },
    files: Array.from({ length: fileCount }, (_, index) => ({
      client_id: `file-${index}`,
      filename: `contract-${index}.pdf`,
      size_bytes: sizeBytes,
    })),
  };
}

describe("parseUploadSessionRequest", () => {
  it("accepts an explicit PDF-generation opt-out for replacements and rejects non-booleans", () => {
    const request = {
      purpose: "document_version_replace",
      destination: { document_id: USER_ID, version_id: SESSION_ID, generate_pdf: false },
      files: [{ ...documentRequest(1).files[0], filename: "contract.docx" }],
    };
    expect(parseUploadSessionRequest(request, USER_ID, SESSION_ID).destination).toMatchObject({ generate_pdf: false });
    expect(() => parseUploadSessionRequest({ ...request, destination: { ...request.destination, generate_pdf: "false" } }, USER_ID, SESSION_ID)).toThrow(UploadSessionValidationError);
  });
  it("accepts a SHA-256 precondition for editor saves and rejects malformed hashes", () => {
    const request = {
      purpose: "document_version_replace",
      destination: { document_id: USER_ID, version_id: SESSION_ID, expected_content_sha256: "a".repeat(64) },
      files: documentRequest(1).files,
    };
    expect(parseUploadSessionRequest(request, USER_ID, SESSION_ID).destination).toMatchObject({ expected_content_sha256: "a".repeat(64) });
    expect(() => parseUploadSessionRequest({ ...request, destination: { ...request.destination, expected_content_sha256: "bad" } }, USER_ID, SESSION_ID)).toThrow(UploadSessionValidationError);
  });
  it("accepts exactly 50 files and derives server-owned storage metadata", () => {
    const result = parseUploadSessionRequest(
      documentRequest(MAX_UPLOAD_SESSION_FILES),
      USER_ID,
      SESSION_ID,
    );

    expect(result.files).toHaveLength(50);
    expect(result.expected_total_bytes).toBe(50 * 1024);
    expect(result.files[0]).toMatchObject({
      file_type: "pdf",
      content_type: "application/pdf",
    });
    expect(result.files[0].staging_storage_path).toContain(
      `upload-sessions/${USER_ID}/${SESSION_ID}/`,
    );
    expect(result.files[0].staging_storage_path).not.toContain(
      "contract-0.pdf",
    );
  });

  it("rejects a 51-file manifest before issuing upload URLs", () => {
    expect(() =>
      parseUploadSessionRequest(
        documentRequest(MAX_UPLOAD_SESSION_FILES + 1),
        USER_ID,
        SESSION_ID,
      ),
    ).toThrow(UploadSessionValidationError);
  });

  it("rejects a file over the individual 100 MB limit", () => {
    expect(() =>
      parseUploadSessionRequest(
        documentRequest(1, MAX_UPLOAD_SIZE_BYTES + 1),
        USER_ID,
        SESSION_ID,
      ),
    ).toThrow(UploadSessionValidationError);
  });

  it("rejects a batch over the 2 GB aggregate limit", () => {
    const fileCount =
      Math.floor(MAX_UPLOAD_SESSION_TOTAL_BYTES / MAX_UPLOAD_SIZE_BYTES) + 1;
    expect(() =>
      parseUploadSessionRequest(
        documentRequest(fileCount, MAX_UPLOAD_SIZE_BYTES),
        USER_ID,
        SESSION_ID,
      ),
    ).toThrow("2 GB total size limit");
  });

  it("requires a single file for version and replacement operations", () => {
    expect(() =>
      parseUploadSessionRequest(
        {
          purpose: "document_version_create",
          destination: {
            document_id: "33333333-3333-4333-8333-333333333333",
          },
          files: documentRequest(2).files,
        },
        USER_ID,
        SESSION_ID,
      ),
    ).toThrow(UploadSessionValidationError);
  });

  it("keeps legacy workflow asset batches compatible while reserving one resource per file", () => {
    const result = parseUploadSessionRequest(
      {
        purpose: "workflow_reference_create",
        destination: {
          workflow_id: "33333333-3333-4333-8333-333333333333",
        },
        files: documentRequest(3).files,
      },
      USER_ID,
      SESSION_ID,
    );

    expect(result.files).toHaveLength(3);
    expect(new Set(result.files.map((file) => file.resource_id)).size).toBe(3);
  });

  it("rejects duplicate client IDs and unknown file metadata", () => {
    expect(() =>
      parseUploadSessionRequest(
        {
          ...documentRequest(2),
          files: [
            { client_id: "same", filename: "a.pdf", size_bytes: 1 },
            { client_id: "same", filename: "b.pdf", size_bytes: 1 },
          ],
        },
        USER_ID,
        SESSION_ID,
      ),
    ).toThrow("client_id values must be unique");

    expect(() =>
      parseUploadSessionRequest(
        {
          ...documentRequest(1),
          files: [
            {
              client_id: "folder-file",
              filename: "contract.pdf",
              relative_path: "Matter/../contract.pdf",
              size_bytes: 1,
            },
          ],
        },
        USER_ID,
        SESSION_ID,
      ),
    ).toThrow("Unrecognized key");
  });

  it("rejects path separators and control characters in display filenames", () => {
    for (const filename of ["folder/contract.pdf", "folder\\contract.pdf", "bad\u0000name.pdf"]) {
      expect(() =>
        parseUploadSessionRequest(
          {
            ...documentRequest(1),
            files: [{ client_id: "unsafe", filename, size_bytes: 1 }],
          },
          USER_ID,
          SESSION_ID,
        ),
      ).toThrow("filename is invalid");
    }
  });

  // A document uploaded on its own belongs to the workspace it is uploaded
  // in: the manifest names that organization, and its absence is Personal.
  it.each([
    ["a standalone document", { scope: "standalone" }],
    ["a library document", { scope: "library", library_kind: "file" }],
  ])("lets %s name the organization it is uploaded in", (_label, destination) => {
    const parsed = parseUploadSessionRequest(
      { ...documentRequest(1), destination: { ...destination, org_id: SESSION_ID } },
      USER_ID,
      SESSION_ID,
    );
    expect(parsed.destination).toMatchObject({ org_id: SESSION_ID });
    // ... or leave it out, or say null, for Personal.
    for (const personal of [{}, { org_id: null }]) {
      expect(() =>
        parseUploadSessionRequest(
          { ...documentRequest(1), destination: { ...destination, ...personal } },
          USER_ID,
          SESSION_ID,
        ),
      ).not.toThrow();
    }
  });

  it("rejects an organization that is not an id, and one named for a project upload", () => {
    expect(() =>
      parseUploadSessionRequest(
        { ...documentRequest(1), destination: { scope: "standalone", org_id: "acme" } },
        USER_ID,
        SESSION_ID,
      ),
    ).toThrow(UploadSessionValidationError);
    // A project decides for what is uploaded into it.
    expect(() =>
      parseUploadSessionRequest(
        {
          ...documentRequest(1),
          destination: { scope: "project", project_id: USER_ID, org_id: SESSION_ID },
        },
        USER_ID,
        SESSION_ID,
      ),
    ).toThrow(UploadSessionValidationError);
  });
});

// A refused manifest is an AppError: should one ever escape the route's
// 4xx mapping, Sentry sees the kind, not "Error: <the user's filename>".
// The HTTP status and client code the route answers with are unchanged.
describe("UploadSessionValidationError", () => {
  it("is an AppError named upload.session_invalid that keeps its status and code", () => {
    const refused = new UploadSessionValidationError("PRIVATE_NAME.docx is too large", {
      status: 413,
      code: "upload_file_too_large",
    });
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toBeInstanceOf(UploadSessionValidationError);
    expect(refused.name).toBe("UploadSessionValidationError");
    expect(refused.status).toBe(413);
    expect(refused.code).toBe("upload_file_too_large");
    expect(refused.message).toContain("PRIVATE_NAME.docx");
    // The kind is what names the event; the boundary also reads `status`
    // (as it does for every error that carries one) but never the message.
    expect(diagnosticErrorTags(refused)).toMatchObject({
      error_kind: "upload.session_invalid",
    });
    expect(JSON.stringify(diagnosticErrorTags(refused))).not.toContain("PRIVATE_NAME");
  });

  it("defaults to 400 invalid_upload_session", () => {
    const refused = new UploadSessionValidationError("bad manifest");
    expect(refused.status).toBe(400);
    expect(refused.code).toBe("invalid_upload_session");
    expect(refused.kind).toBe("upload.session_invalid");
  });

  it("is what the parser throws", () => {
    let thrown: unknown;
    try {
      parseUploadSessionRequest(documentRequest(MAX_UPLOAD_SESSION_FILES + 1), USER_ID, SESSION_ID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UploadSessionValidationError);
    expect(diagnosticErrorTags(thrown)).toMatchObject({ error_kind: "upload.session_invalid" });
  });
});

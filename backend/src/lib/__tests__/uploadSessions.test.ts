import { describe, expect, it } from "vitest";

import {
  MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SESSION_FILES,
  MAX_UPLOAD_SESSION_TOTAL_BYTES,
  parseUploadSessionRequest,
  UploadSessionValidationError,
} from "../uploadSessions";

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

  it("allows a workflow reference batch while reserving one resource per file", () => {
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
});

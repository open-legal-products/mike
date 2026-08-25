import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  checkProjectAccess: vi.fn(),
  ensureDocAccess: vi.fn(),
}));

vi.mock("../access", () => accessMocks);

import { validateDestinationAccess } from "../../routes/uploadSessions";

function response() {
  return {
    status: vi.fn(function status() {
      return this;
    }),
    json: vi.fn(function json() {
      return this;
    }),
  };
}

function dbWith(rows: Record<string, unknown>) {
  return {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: Array.isArray(rows[table]) ? rows[table] : [],
            error: null,
          }).then(resolve),
      };
      return query;
    },
  };
}

const file = {
  id: "33333333-3333-4333-8333-333333333333",
  resource_id: "44444444-4444-4444-8444-444444444444",
  client_id: "client-1",
  filename: "contract.pdf",
  target_folder_id: null,
  file_type: "pdf",
  content_type: "application/pdf",
  expected_size_bytes: 4,
  staging_storage_path: "staging",
  sealed_storage_path: "sealed",
};

describe("upload destination authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a project the user cannot access", async () => {
    accessMocks.checkProjectAccess.mockResolvedValue({ ok: false });
    const res = response();
    const allowed = await validateDestinationAccess(
      {
        purpose: "document_create",
        destination: {
          scope: "project",
          project_id: "55555555-5555-4555-8555-555555555555",
        },
        expected_total_bytes: 4,
        files: [file],
      },
      "11111111-1111-4111-8111-111111111111",
      "user@example.com",
      dbWith({}) as never,
      res as never,
    );
    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("rejects a document the user cannot edit", async () => {
    accessMocks.ensureDocAccess.mockResolvedValue({ ok: false });
    const res = response();
    const allowed = await validateDestinationAccess(
      {
        purpose: "document_version_create",
        destination: {
          document_id: "55555555-5555-4555-8555-555555555555",
        },
        expected_total_bytes: 4,
        files: [file],
      },
      "11111111-1111-4111-8111-111111111111",
      "user@example.com",
      dbWith({
        documents: {
          id: "55555555-5555-4555-8555-555555555555",
          user_id: "another-user",
          project_id: null,
        },
      }) as never,
      res as never,
    );
    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("rejects a workflow that is neither owned nor editable", async () => {
    const res = response();
    const allowed = await validateDestinationAccess(
      {
        purpose: "workflow_reference_create",
        destination: {
          workflow_id: "55555555-5555-4555-8555-555555555555",
        },
        expected_total_bytes: 4,
        files: [file],
      },
      "11111111-1111-4111-8111-111111111111",
      "user@example.com",
      dbWith({
        workflows: {
          id: "55555555-5555-4555-8555-555555555555",
          user_id: "another-user",
          type: "assistant",
        },
        workflow_shares: { allow_edit: false },
      }) as never,
      res as never,
    );
    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

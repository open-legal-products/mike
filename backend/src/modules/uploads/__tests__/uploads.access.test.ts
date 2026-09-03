import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  checkProjectAccess: vi.fn(),
  ensureDocAccess: vi.fn(),
}));

vi.mock("../../../lib/access", () => accessMocks);

import { validateDestinationAccess } from "../uploads.access";

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

// The guard returns a failure instead of writing to `res`; the route turns
// `status` into the response. A rejected destination is always a 404 so the
// answer never reveals whether the resource exists.
function rejection(outcome: Awaited<ReturnType<typeof validateDestinationAccess>>) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected the destination to be rejected");
  if (outcome.kind !== "http") throw new Error("expected an http failure");
  return outcome;
}

describe("upload destination authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a project the user cannot access", async () => {
    accessMocks.checkProjectAccess.mockResolvedValue({ ok: false });
    const outcome = await validateDestinationAccess(
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
    );
    expect(rejection(outcome).status).toBe(404);
  });

  it("rejects a document the user cannot edit", async () => {
    accessMocks.ensureDocAccess.mockResolvedValue({ ok: false });
    const outcome = await validateDestinationAccess(
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
    );
    expect(rejection(outcome).status).toBe(404);
  });

  it("rejects a workflow that is neither owned nor editable", async () => {
    const outcome = await validateDestinationAccess(
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
    );
    expect(rejection(outcome).status).toBe(404);
  });
});

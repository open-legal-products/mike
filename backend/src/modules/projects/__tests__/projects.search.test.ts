import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../../lib/documentVersions", () => ({
  attachActiveVersionPaths: vi.fn(), attachLatestVersionNumbers: vi.fn(),
}));
vi.mock("../projects.shared", async original => ({
  ...(await original<typeof import("../projects.shared")>()),
  attachDocumentOwnerLabels: vi.fn(),
}));
import { attachActiveVersionPaths, attachLatestVersionNumbers } from "../../../lib/documentVersions";
import { attachDocumentOwnerLabels } from "../projects.shared";
import { searchProjectDirectory } from "../projects.service";

beforeEach(() => vi.clearAllMocks());

it("pages authorized projects in SQL before enriching only the returned documents in bounded chunks", async () => {
  const documents = Array.from({ length: 121 }, (_, i) => ({
    id: `d${i}`, project_id: "mine", current_version_id: `v${1000 + i}`,
  }));
  const requests: URL[] = [];
  const db = createClient("https://supabase.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requests.push(url);
      expect(url.pathname).toBe("/rest/v1/rpc/search_project_directory");
      expect(JSON.parse(String(init?.body))).toEqual({
        p_user_id: "owner", p_user_email: "owner@example.com", p_search_term: "contract%_\\",
        p_limit: 20, p_offset: 40, p_workspace: "personal",
      });
      return new Response(JSON.stringify([{ id: "mine", documents, folders: [] }]), {
        headers: { "Content-Type": "application/json" },
      });
    } },
  });
  const result = await searchProjectDirectory(db, {
    userId: "owner", userEmail: " OWNER@EXAMPLE.COM ", searchTerm: "contract%_\\",
    pagination: { offset: 40, limit: 20 }, workspace: "personal",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data).toHaveLength(1);
  expect((result.data[0] as { documents: unknown[] }).documents).toEqual(documents);
  expect(requests).toHaveLength(1);
  for (const enrich of [attachLatestVersionNumbers, attachActiveVersionPaths, attachDocumentOwnerLabels]) {
    expect(vi.mocked(enrich).mock.calls.map(call => call[1].length)).toEqual([50, 50, 21]);
    expect(vi.mocked(enrich).mock.calls.flatMap(call => call[1] as readonly unknown[])).toEqual(documents);
  }
});

it("does not enrich any documents after a failed authorization query", async () => {
  const error = { message: "query failed" };
  const db = { rpc: vi.fn().mockResolvedValue({ data: null, error }) };
  const result = await searchProjectDirectory(db as never, {
    userId: "caller", searchTerm: "", pagination: { limit: 20, offset: 0 },
  });
  expect(result).toEqual({ ok: false, error });
  expect(attachActiveVersionPaths).not.toHaveBeenCalled();
});

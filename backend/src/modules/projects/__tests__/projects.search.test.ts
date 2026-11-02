import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
vi.mock("../../../lib/documentVersions", () => ({
  attachActiveVersionPaths: vi.fn(), attachLatestVersionNumbers: vi.fn(),
}));
vi.mock("../projects.shared", async original => ({
  ...(await original<typeof import("../projects.shared")>()),
  attachDocumentOwnerLabels: vi.fn(),
}));
import { searchProjectDirectory } from "../projects.service";

it("searches scoped current versions beyond global row caps and pages all matches", async () => {
  const documents = Array.from({ length: 121 }, (_, i) => ({
    id: `d${i}`, project_id: "mine", current_version_id: `v${1000 + i}`,
    active_version: { filename: "contract.pdf", deleted_at: null },
  }));
  const requests: URL[] = [];
  const db = createClient("https://supabase.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async input => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requests.push(url);
      let data: unknown = [];
      if (url.pathname.endsWith("/projects")) data = [{ id: "mine", user_id: "owner", org_id: null, name: "Matter" }];
      if (url.pathname.endsWith("/document_versions")) {
        // The old global filename query is capped before this project's hits.
        data = Array.from({ length: 1000 }, (_, i) => ({ id: `v${i}` }));
      }
      if (url.pathname.endsWith("/documents")) {
        expect(url.searchParams.get("project_id")).toBe("in.(mine)");
        if (url.searchParams.has("current_version_id")) data = [];
        else {
          expect(url.searchParams.get("select")).toContain("document_versions!documents_current_version_id_fkey!inner");
          expect(url.searchParams.get("active_version.filename")).toBe("ilike.%contract\\%\\_\\\\%");
          expect(url.searchParams.get("active_version.deleted_at")).toBe("is.null");
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 1000);
          expect(limit).toBeLessThanOrEqual(50);
          data = documents.slice(offset, offset + limit);
        }
      }
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    } },
  });
  const result = await searchProjectDirectory(db, {
    userId: "owner", searchTerm: "contract%_\\", pagination: { offset: 0, limit: 20 },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data).toHaveLength(1);
  expect((result.data[0] as { documents: unknown[] }).documents).toHaveLength(121);
  expect(requests.filter(url => url.pathname.endsWith("/documents"))).toHaveLength(3);
  expect(requests.some(url => url.pathname.endsWith("/document_versions"))).toBe(false);
});

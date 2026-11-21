import { expect, it, vi } from "vitest";
vi.mock("../../../lib/storage", () => ({}));
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { attachProjectMemoryEnabled } from "../projects.shared";

it("reads memory settings for a page of 100 projects in bounded batches", async () => {
  const projects = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}` }));
  const fake = tableDb({
    memory_files: projects.map((project, i) => ({ scope: "project", project_id: project.id, enabled: i % 2 === 0 })),
  });
  const result = await attachProjectMemoryEnabled(fake.db, projects);
  expect(result.error).toBeNull();
  expect(result.rows.filter((row) => (row as { memory_enabled?: boolean }).memory_enabled)).toHaveLength(50);
});

import { describe, expect, it, vi } from "vitest";
import { buildProjectDocContext } from "../chat/contextBuilders";
import type { createServerSupabase } from "../supabase";

function contextDatabase() {
  const documents = [
    {
      id: "project-doc",
      project_id: "p1",
      user_id: "other",
      status: "ready",
      folder_id: "folder-1",
      current_version_id: "v1",
    },
    {
      id: "attachment",
      project_id: null,
      user_id: "u1",
      status: "ready",
      current_version_id: "v2",
    },
    {
      id: "private-doc",
      project_id: null,
      user_id: "other",
      status: "ready",
      current_version_id: "v3",
    },
    {
      id: "pending-doc",
      project_id: null,
      user_id: "u1",
      status: "processing",
      current_version_id: "v4",
    },
  ];
  const tables: Record<string, Array<Record<string, unknown>>> = {
    documents,
    project_subfolders: [
      {
        id: "folder-1",
        name: "Drafts",
        project_id: "p1",
        parent_folder_id: null,
      },
    ],
    document_versions: documents.map((doc, index) => ({
      id: doc.current_version_id,
      filename: `${doc.id}.pdf`,
      storage_path: `files/${doc.id}.pdf`,
      file_type: "pdf",
      version_number: index + 1,
      deleted_at: null,
    })),
  };
  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])];
    const query = {
      select: vi.fn(() => query),
      order: vi.fn(() => query),
      eq: vi.fn((field: string, value: unknown) => {
        rows = rows.filter((row) => row[field] === value);
        return query;
      }),
      in: vi.fn((field: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[field]));
        return query;
      }),
      is: vi.fn((field: string, value: unknown) => query.eq(field, value)),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: rows.map((row) => ({ ...row })),
          error: null,
        }).then(resolve),
    };
    return query;
  });
  return {
    db: { from } as unknown as ReturnType<typeof createServerSupabase>,
    documents,
    from,
  };
}

describe("project chat document context", () => {
  it("reads project files and direct attachments without assigning attachments or duplicating project files", async () => {
    const { db, documents, from } = contextDatabase();
    const context = await buildProjectDocContext("p1", "u1", db, [
      {
        role: "user",
        content: "Earlier attachment",
        files: [{ filename: "attachment.pdf", document_id: "attachment" }],
      },
      {
        role: "user",
        content: "Compare these files",
        files: [
          { filename: "project.pdf", document_id: "project-doc" },
          { filename: "attachment.pdf", document_id: "attachment" },
          { filename: "private.pdf", document_id: "private-doc" },
          { filename: "pending.pdf", document_id: "pending-doc" },
        ],
      },
    ]);

    expect(
      Object.values(context.docIndex).map((doc) => doc.document_id),
    ).toEqual(["project-doc", "attachment"]);
    const projectLabel = Object.keys(context.docIndex).find(
      (key) => context.docIndex[key].document_id === "project-doc",
    )!;
    const attachmentLabel = Object.keys(context.docIndex).find(
      (key) => context.docIndex[key].document_id === "attachment",
    )!;
    expect(context.folderPaths.get(projectLabel)).toBe("Drafts");
    expect(context.docStore.get(attachmentLabel)).toMatchObject({
      storage_path: "files/attachment.pdf",
      filename: "attachment.pdf",
    });
    expect(context.docIndex[attachmentLabel].version_number).toBe(2);
    expect(
      documents.find((doc) => doc.id === "attachment")?.project_id,
    ).toBeNull();
    expect(
      from.mock.results.every(
        ({ value }) => !("update" in value) && !("insert" in value),
      ),
    ).toBe(true);
  });

  it("avoids a separate attachment lookup when only project files are attached", async () => {
    const { db, from } = contextDatabase();
    await buildProjectDocContext("p1", "u1", db, [
      {
        role: "user",
        content: "Read this",
        files: [{ filename: "project.pdf", document_id: "project-doc" }],
      },
    ]);
    expect(
      from.mock.calls.filter(([table]) => table === "documents"),
    ).toHaveLength(1);
  });
});

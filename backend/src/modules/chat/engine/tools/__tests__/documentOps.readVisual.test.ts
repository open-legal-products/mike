import { expect, it, vi } from "vitest";
import { serializeVisual } from "../../../../../lib/visuals/source";

const mocks = vi.hoisted(() => ({ downloadFile: vi.fn() }));

vi.mock("../../../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/storage")>()),
  downloadFile: mocks.downloadFile,
}));

import { readDocumentContent } from "../documentOps";

it("reads a visual as its page with the data blocks named, not shown", async () => {
  mocks.downloadFile.mockResolvedValue(
    serializeVisual({
      title: "Rent roll",
      kind: "dashboard",
      summary: "",
      html: `<script type="application/json" id="mv-data-rents">[{"unit":"A","rent":1200}]</script>\n<div class="mv-page"><h1>Rent roll</h1></div>`,
      kit: "1",
      createdAt: "2026-10-20T09:30:00Z",
      sources: [],
    }),
  );
  const docStore = new Map([
    ["doc-1", { storage_path: "generated/u1/d1/Rent roll.html", file_type: "html", filename: "Rent roll.html" }],
  ]);

  const text = await readDocumentContent("doc-1", docStore, () => {}, {}, undefined, { emitEvents: false });

  expect(text).toContain("edit_visual with its doc_id and the changes in words");
  expect(text).toContain("[Data blocks the page reads with MikeVisual.data(name): rents]");
  expect(text).toContain("<h1>Rent roll</h1>");
  expect(text).not.toContain("1200");
});

import { getVisualDocx } from "../api/client";
import type { WordVisualRef } from "./visuals";

/**
 * Insert the visual as Word content in a paragraph of its own after the
 * selection: its headings, text and tables take the document's own styles,
 * and each chart is a picture. Inserting at the cursor itself would split
 * the user's paragraph around the visual.
 */
export async function insertVisualIntoDocument(
  visual: WordVisualRef,
): Promise<void> {
  const docx = await getVisualDocx(visual.documentId, visual.versionId);
  await Word.run(async (context) => {
    const paragraph = context.document
      .getSelection()
      .paragraphs.getLast()
      .insertParagraph("", "After");
    paragraph.insertFileFromBase64(docx, "Replace");
    await context.sync();
  });
}

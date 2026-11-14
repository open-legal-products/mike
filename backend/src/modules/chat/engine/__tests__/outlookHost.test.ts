import { describe, expect, it } from "vitest";
import { buildWordChatSystemPrompt } from "../wordPrompt";
import {
  OUTLOOK_CLIENT_TOOLS,
  WORD_CLIENT_TOOLS,
  createWordClientToolsAdapter,
} from "../tools/wordClientTools";

describe("Outlook host", () => {
  it("keeps the Word prompts unchanged by default", () => {
    expect(buildWordChatSystemPrompt(true)).toBe(buildWordChatSystemPrompt(true, "word"));
    expect(buildWordChatSystemPrompt(true)).toContain("Microsoft Word");
  });

  it("gives Outlook its own compose prompt with text-card drafts", () => {
    const prompt = buildWordChatSystemPrompt(true, "outlook");
    expect(prompt).toContain("Microsoft Outlook");
    expect(prompt).toContain("create_text_card");
    expect(prompt).toContain("<untrusted-content>");
    expect(prompt).not.toContain("<EDITS>");
    expect(prompt).not.toContain("Microsoft Word");
  });

  it("offers Outlook the live read only", async () => {
    const adapter = createWordClientToolsAdapter({ userId: "u1", write: () => {}, host: "outlook" });
    expect(adapter.schemas).toBe(OUTLOOK_CLIENT_TOOLS);
    expect(adapter.schemas.map((t) => t.function.name)).toEqual(["read_active_document"]);
    const refused = await adapter.execute({ id: "c1", name: "apply_word_edits", input: { edits: [] } } as never);
    expect(refused.content).toContain("Outlook has no edit channel");
  });

  it("leaves the Word adapter as it was", () => {
    const adapter = createWordClientToolsAdapter({ userId: "u1", write: () => {} });
    expect(adapter.schemas).toBe(WORD_CLIENT_TOOLS);
  });
});

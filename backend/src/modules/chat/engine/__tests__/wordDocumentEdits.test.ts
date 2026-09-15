import { describe, expect, it } from "vitest";
import { projectWordDocumentEditEvents } from "../wordDocumentEdits";

describe("projectWordDocumentEditEvents", () => {
  it("keeps prose and edit references in exact source order", () => {
    const result = projectWordDocumentEditEvents([
      {
        type: "content",
        text: [
          "Opening prose.",
          "<EDITS>",
          JSON.stringify([
            {
              type: "edit_data",
              kind: "edit",
              deleted_text: "ten days",
              inserted_text: "five days",
              reason: "Shortens the cure period",
            },
            {
              type: "edit_data",
              kind: "edit",
              deleted_text: "written notice",
              formats: ["bold"],
              reason: "Highlights the requirement",
            },
          ]),
          "</EDITS>",
          "Closing prose.",
        ].join("\n"),
      },
    ]);

    expect(result.edits).toEqual([
      expect.objectContaining({
        blockIndex: 0,
        originalText: "ten days",
        replacementText: "five days",
      }),
      expect.objectContaining({
        blockIndex: 1,
        originalText: "written notice",
        formats: ["bold"],
      }),
    ]);
    expect(
      result.parts.map((part) =>
        part.kind === "content" ? part.text : `edit:${part.blockIndex}`,
      ),
    ).toEqual(["Opening prose.", "edit:0", "edit:1", "Closing prose."]);
  });

  it("leaves incomplete protocol in content instead of inventing an edit", () => {
    const source = 'Before\n<EDITS>\n[{"type":"edit_data"';
    const result = projectWordDocumentEditEvents([
      { type: "content", text: source },
    ]);

    expect(result.edits).toEqual([]);
    expect(result.parts).toEqual([
      expect.objectContaining({
        kind: "content",
        sourceEvent: { type: "content", text: source },
      }),
    ]);
  });

  it("preserves significant whitespace in JSON edit text", () => {
    const result = projectWordDocumentEditEvents([
      {
        type: "content",
        text: `<EDITS>${JSON.stringify([
          {
            type: "edit_data",
            kind: "edit",
            deleted_text: " target ",
            inserted_text: " replacement ",
            reason: "Preserves spacing",
          },
        ])}</EDITS>`,
      },
    ]);

    expect(result.edits[0]).toMatchObject({
      originalText: " target ",
      replacementText: " replacement ",
    });
  });
});

describe("projectWordDocumentEditEvents with tool-proposed edits", () => {
  it("places a word_edit_block exactly where the tool call landed", () => {
    const result = projectWordDocumentEditEvents([
      { type: "content", text: "Looking at the payment clause." },
      {
        type: "word_edit_block",
        block_index: 1_000,
        original_text: "ten days",
        replacement_text: "five days",
        formats: [],
        occurrence: null,
        reason: "Shortens the cure period",
      },
      {
        type: "word_edit_block",
        block_index: 1_001,
        original_text: "written notice",
        replacement_text: "",
        formats: ["bold"],
        occurrence: null,
        reason: "Highlights the requirement",
      },
      { type: "content", text: "Both changes are ready for review." },
    ]);

    expect(result.edits).toEqual([
      expect.objectContaining({
        blockIndex: 1_000,
        originalText: "ten days",
        replacementText: "five days",
        formats: [],
        occurrence: null,
      }),
      expect.objectContaining({
        blockIndex: 1_001,
        originalText: "written notice",
        formats: ["bold"],
      }),
    ]);
    // Same part shape as the <EDITS> channel: the normalized history a chat
    // replays cannot tell which channel produced a card.
    expect(
      result.parts.map((part) =>
        part.kind === "content" ? part.text : `edit:${part.blockIndex}`,
      ),
    ).toEqual([
      "Looking at the payment clause.",
      "edit:1000",
      "edit:1001",
      "Both changes are ready for review.",
    ]);
  });

  it("carries an explicit replace-all through", () => {
    const result = projectWordDocumentEditEvents([
      {
        type: "word_edit_block",
        block_index: 1_000,
        original_text: "Seller",
        replacement_text: "Vendor",
        formats: [],
        occurrence: "all",
        reason: "Rename the party",
      },
    ]);
    expect(result.edits[0]?.occurrence).toBe("all");
  });

  it("drops a duplicate ordinal rather than upserting two edits onto one row", () => {
    const block = {
      type: "word_edit_block",
      block_index: 1_000,
      replacement_text: "x",
      formats: [],
      occurrence: null,
      reason: null,
    };
    const result = projectWordDocumentEditEvents([
      { ...block, original_text: "first" },
      { ...block, original_text: "second" },
    ]);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]?.originalText).toBe("first");
  });

  it("ignores a marker the canonical row could not hold", () => {
    const result = projectWordDocumentEditEvents([
      {
        type: "word_edit_block",
        block_index: 1_000,
        original_text: "x".repeat(201),
        replacement_text: "y",
        formats: [],
        occurrence: null,
        reason: null,
      },
      {
        type: "word_edit_block",
        block_index: -1,
        original_text: "valid",
        replacement_text: "y",
        formats: [],
        occurrence: null,
        reason: null,
      },
    ]);
    expect(result.edits).toEqual([]);
    expect(result.parts).toEqual([]);
  });
});

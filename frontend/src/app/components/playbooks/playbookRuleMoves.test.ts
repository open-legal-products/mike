import { describe, expect, it } from "vitest";
import type { PlaybookContent, PlaybookRule } from "@/app/lib/mikeApi";
import { movePlaybookRule } from "./playbookRuleMoves";

const rule = (id: string) =>
  ({
    id,
    name: id,
    guidance: `Guidance for ${id}`,
    sourceRefs: ["P1"],
  }) as PlaybookRule;
const content = (): PlaybookContent => ({
  name: "Guide",
  description: "",
  representedParty: "",
  documentTypes: [],
  jurisdictions: [],
  rules: [rule("a"), rule("b"), rule("c")],
  topics: [
    { id: "group", name: "Group", rules: [rule("d"), rule("e")] },
    { id: "empty", name: "Empty", rules: [] },
  ],
});

describe("moving playbook rules", () => {
  it.each([
    ["a", "c", "after", ["b", "c", "a"]],
    ["c", "a", "before", ["c", "a", "b"]],
    ["a", "c", "before", ["b", "a", "c"]],
    ["c", "a", "after", ["a", "c", "b"]],
  ] as const)(
    "places %s %s %s without an off-by-one move",
    (id, anchor, position, expected) => {
      const original = content();
      const result = movePlaybookRule(original, id, {
        topicId: null,
        ruleId: anchor,
        position,
      });
      expect(result.rules?.map((entry) => entry.id)).toEqual(expected);
      expect(original.rules?.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    },
  );

  it("moves a rule between groups and back to the root without losing its content", () => {
    const original = content();
    const moved = movePlaybookRule(original, "d", { topicId: "empty" });
    expect(moved.topics[0].rules.map((entry) => entry.id)).toEqual(["e"]);
    expect(moved.topics[1].rules[0]).toBe(original.topics[0].rules[0]);
    const root = movePlaybookRule(moved, "d", {
      topicId: null,
      ruleId: "b",
      position: "before",
    });
    expect(root.rules?.map((entry) => entry.id)).toEqual(["a", "d", "b", "c"]);
    expect(root.topics[1].rules).toEqual([]);
    expect(root.rules?.[1]).toEqual(original.topics[0].rules[0]);
  });

  it("reorders a topic and accepts an empty root in older playbooks", () => {
    const original = content();
    delete original.rules;
    const moved = movePlaybookRule(original, "e", {
      topicId: "group",
      ruleId: "d",
      position: "before",
    });
    expect(moved.topics[0].rules.map((entry) => entry.id)).toEqual(["e", "d"]);
    expect(
      movePlaybookRule(moved, "e", { topicId: null }).rules?.map(
        (entry) => entry.id,
      ),
    ).toEqual(["e"]);
  });

  it("ignores stale destinations, missing rules, and no-op drops", () => {
    const original = content();
    for (const [id, target] of [
      ["missing", { topicId: null }],
      ["a", { topicId: "missing" }],
      ["a", { topicId: null, ruleId: "missing" }],
      ["a", { topicId: null, ruleId: "a" }],
      ["a", { topicId: null, ruleId: "b", position: "before" }],
      ["c", { topicId: null }],
    ] as const)
      expect(movePlaybookRule(original, id, target)).toBe(original);
  });
});

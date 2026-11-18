/**
 * What tool-call validation counts: one outcome per checked call, per tool,
 * with the real pi-schema checker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  flushToolActivity,
  setToolActivitySinkForTests,
  type ToolActivityCount,
} from "../toolActivity";
import { buildToolInputCheck, loadToolInputChecker } from "./toolInputValidation";

const SCHEMA = {
  type: "object",
  properties: { doc_id: { type: "string" } },
  required: ["doc_id"],
};

let counted: ToolActivityCount[];
beforeEach(() => {
  counted = [];
  setToolActivitySinkForTests((counts) => {
    counted.push(...counts.map((count) => ({ ...count })));
  });
});
afterEach(() => {
  setToolActivitySinkForTests(null);
  vi.restoreAllMocks();
});

const row = (kind: string, tool: string, outcome: string, count: number) => ({
  kind,
  tool,
  outcome,
  count,
});

describe("tool-call validation counts", () => {
  it("counts refused and passed calls per tool in enforce", async () => {
    const check = (await loadToolInputChecker("enforce"))("read_document", { ...SCHEMA })!;
    expect(check({ doc_id: "d1" }).success).toBe(true);
    expect(check({}).success).toBe(false);
    expect(check({ doc_id: 3 }).success).toBe(false);
    flushToolActivity();
    expect(counted).toEqual(
      expect.arrayContaining([
        row("tool_input", "read_document", "passed", 1),
        row("tool_input", "read_document", "refused", 2),
      ]),
    );
    expect(counted).toHaveLength(2);
  });

  it("counts a mismatch that log mode let run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const check = (await loadToolInputChecker("log"))("read_document", { ...SCHEMA })!;
    expect(check({}).success).toBe(true);
    flushToolActivity();
    expect(counted).toEqual([row("tool_input", "read_document", "mismatch_allowed", 1)]);
  });

  it("counts a script's calls apart from the model's, and connectors under one label", async () => {
    const checker = await loadToolInputChecker("enforce", "script_tool_input");
    checker("read_document", { ...SCHEMA })!({});
    (await loadToolInputChecker("enforce"))("mcp_acme-matters_search_ab12", { ...SCHEMA })!({});
    flushToolActivity();
    expect(counted).toEqual(
      expect.arrayContaining([
        row("script_tool_input", "read_document", "refused", 1),
        row("tool_input", "connector", "refused", 1),
      ]),
    );
  });

  it("counts the calls that ran unchecked: a checker that threw, a schema that cannot be checked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const throws = (() => ({
      validate: () => {
        throw new Error("too deep");
      },
    })) as unknown as Parameters<typeof buildToolInputCheck>[0];
    const check = buildToolInputCheck(throws, "find_documents", { ...SCHEMA }, "enforce")!;
    expect(check({}).success).toBe(true);

    const checker = await loadToolInputChecker("enforce");
    expect(checker("list_documents", { $ref: "#/$defs/missing" })).toBeUndefined();
    flushToolActivity();
    expect(counted).toEqual(
      expect.arrayContaining([
        row("tool_input", "find_documents", "check_failed", 1),
        row("tool_input", "list_documents", "schema_unchecked", 1),
      ]),
    );
  });
});

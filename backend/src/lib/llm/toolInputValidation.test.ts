/**
 * Tool-argument validation: the pi-schema checks themselves, and their effect
 * through a real streamText loop on a stub model (no network, no keys).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { streamAiSdk } from "./aiSdk";
import {
  buildToolInputCheck,
  describeToolInputErrors,
  loadToolInputChecker,
  toolInputValidationMode,
  ToolInputValidationError,
} from "./toolInputValidation";
import type { NormalizedToolCall, OpenAIToolSchema } from "./types";
import {
  PLAYBOOK_TOOLS,
  PROJECT_EXTRA_TOOLS,
  TABULAR_TOOLS,
  TOOLS,
  WORKFLOW_TOOLS,
} from "../../modules/chat/engine/tools/toolSchemas";
import { COURTLISTENER_TOOLS } from "../../modules/chat/engine/tools/courtlistenerTools";
import { ASK_PARENT_TOOL, delegateTool } from "../../modules/chat/engine/tools/delegateTools";
import { WORD_CLIENT_TOOLS } from "../../modules/chat/engine/tools/wordClientTools";
import { webToolsFor } from "../../modules/chat/engine/tools/webSearchTools";
import { WORKSPACE_TOOLS } from "../integrations/googleWorkspaceApi";
import { DRIVE_WRITE_TOOLS } from "../integrations/googleDriveWrites";
import { z } from "zod";
import {
  callStep,
  config,
  makeModel,
  okRunTools,
  textStep,
} from "./__tests__/mockLanguageModel";

type Compile = Parameters<typeof buildToolInputCheck>[0];
let compile: Compile;
beforeAll(async () => {
  ({ compile } = await import("@earendil-works/pi-schema"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const REPLICATE: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "replicate_document",
    description: "Copy a document.",
    parameters: {
      type: "object",
      properties: {
        doc_id: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["doc_id"],
    },
  },
};

describe("toolInputValidationMode", () => {
  it("defaults to log and accepts off and enforce in any case", () => {
    expect(toolInputValidationMode({})).toBe("log");
    expect(toolInputValidationMode({ TOOL_INPUT_VALIDATION: "" })).toBe("log");
    expect(toolInputValidationMode({ TOOL_INPUT_VALIDATION: "nonsense" })).toBe("log");
    expect(toolInputValidationMode({ TOOL_INPUT_VALIDATION: " Enforce " })).toBe("enforce");
    expect(toolInputValidationMode({ TOOL_INPUT_VALIDATION: "OFF" })).toBe("off");
  });
});

describe("buildToolInputCheck", () => {
  const params = REPLICATE.function.parameters;

  it("passes a valid value through as the same object", () => {
    const check = buildToolInputCheck(compile, "t", params, "enforce")!;
    const value = { doc_id: "doc-0", count: 2 };
    const result = check(value);
    expect(result).toEqual({ success: true, value });
    expect(result.success && result.value).toBe(value);
  });

  it("enforce refuses a mismatch and names each failing path", () => {
    const check = buildToolInputCheck(compile, "replicate_document", params, "enforce")!;
    const result = check({ count: 50 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ToolInputValidationError);
    expect(result.error.message).toContain("replicate_document");
    expect(result.error.message).toContain("/doc_id");
    expect(result.error.message).toContain("required");
    expect(result.error.message).toContain("/count");
    expect(result.error.message).toContain("maximum");
    expect(result.error.message).toContain("Nothing ran");
  });

  it("does not coerce: a numeric string for an integer is refused", () => {
    const check = buildToolInputCheck(compile, "t", params, "enforce")!;
    expect(check({ doc_id: "d", count: "3" }).success).toBe(false);
    // pi-schema's coercion would have turned this null into "null".
    expect(check({ doc_id: null }).success).toBe(false);
  });

  it("log lets a mismatch through unchanged and logs paths, never values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const check = buildToolInputCheck(compile, "replicate_document", params, "log")!;
    const value = { doc_id: "secret-client-name", count: 99 };
    const result = check(value);
    expect(result).toEqual({ success: true, value });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("replicate_document");
    expect(line).toContain("/count maximum");
    expect(line).not.toContain("secret-client-name");
    expect(line).not.toContain("99");
  });

  it("leaves a tool unchecked when its schema does not compile, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { type: "object", properties: { a: { type: "string", pattern: "(" } } };
    expect(buildToolInputCheck(compile, "mcp_broken", broken, "enforce")).toBeUndefined();
    expect(
      buildToolInputCheck(compile, "mcp_broken", { ...broken }, "enforce"),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("fails only the values at a dangling $ref", () => {
    const check = buildToolInputCheck(
      compile,
      "t",
      {
        type: "object",
        properties: { a: { $ref: "#/$defs/missing" }, b: { type: "string" } },
      },
      "enforce",
    )!;
    expect(check({ b: "x" }).success).toBe(true);
    expect(check({ a: 1 }).success).toBe(false);
  });

  it("reads a draft-07 schema with draft-07 semantics", () => {
    // In draft 7, `items` as an array is the tuple form; 2020-12 would reject
    // the schema's shape differently (prefixItems).
    const check = buildToolInputCheck(
      compile,
      "t",
      {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      },
      "enforce",
    )!;
    expect(check({ pair: ["a", 1] }).success).toBe(true);
    expect(check({ pair: [1, "a"] }).success).toBe(false);
  });

  it("ignores a missing or non-object schema", () => {
    expect(buildToolInputCheck(compile, "t", undefined, "enforce")).toBeUndefined();
    expect(buildToolInputCheck(compile, "t", [], "enforce")).toBeUndefined();
  });

  it("caps the reported problems", () => {
    const errors = Array.from({ length: 8 }, (_, i) => ({
      path: `/f${i}`,
      keyword: "type",
      message: "expected string",
    }));
    const message = describeToolInputErrors("t", errors);
    expect(message).toContain("/f4");
    expect(message).not.toContain("/f5");
    expect(message).toContain("and 3 more");
    expect(describeToolInputErrors("t", [{ path: "", keyword: "type", message: "expected object" }]))
      .toContain("(arguments): expected object");
  });
});

describe("loadToolInputChecker", () => {
  it("off builds no checks", async () => {
    const checker = await loadToolInputChecker("off");
    expect(checker("t", REPLICATE.function.parameters)).toBeUndefined();
  });

  it("every built-in tool schema compiles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Google tools are zod schemas, converted exactly as the connectors do.
    const fromZod = (tools: ReadonlyArray<{ name: string; schema: unknown }>) =>
      tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: "",
          parameters: z.toJSONSchema(t.schema as never, {
            target: "draft-7",
            io: "input",
          }) as Record<string, unknown>,
        },
      }));
    const checker = await loadToolInputChecker("enforce");
    const all = [
      ...TOOLS,
      ...PROJECT_EXTRA_TOOLS,
      ...TABULAR_TOOLS,
      ...WORKFLOW_TOOLS,
      ...PLAYBOOK_TOOLS,
      ...COURTLISTENER_TOOLS,
      ...WORD_CLIENT_TOOLS,
      ...webToolsFor("brave"),
      ASK_PARENT_TOOL,
      delegateTool("model-a", ["model-a", "model-b"]),
      ...fromZod(WORKSPACE_TOOLS),
      ...fromZod(DRIVE_WRITE_TOOLS),
    ] as OpenAIToolSchema[];
    expect(all.length).toBeGreaterThan(30);
    for (const tool of all) {
      expect(
        checker(tool.function.name, tool.function.parameters),
        tool.function.name,
      ).toBeTypeOf("function");
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("through the AI SDK loop", () => {
  const base = {
    model: "m",
    systemPrompt: "S",
    messages: [{ role: "user" as const, content: "go" }],
    tools: [REPLICATE],
    maxIterations: 5,
  };

  const toolResultsSentIn = (prompt: unknown): string =>
    JSON.stringify(
      (prompt as Array<{ role: string }>).filter((m) => m.role === "tool"),
    );

  it("enforce: an invalid call never runs, the model sees why and the turn goes on", async () => {
    vi.stubEnv("TOOL_INPUT_VALIDATION", "enforce");
    const model = await makeModel([
      callStep("c1", "replicate_document", { count: 50 }),
      callStep("c2", "replicate_document", { doc_id: "doc-0", count: 2 }),
      textStep("done"),
    ]);
    const batches: NormalizedToolCall[][] = [];
    const starts: NormalizedToolCall[] = [];
    const res = await streamAiSdk(
      {
        ...base,
        callbacks: { onToolCallStart: (call) => starts.push(call) },
        runTools: async (calls) => {
          batches.push(calls);
          return okRunTools(calls);
        },
      },
      config(model),
    );
    expect(res.fullText).toBe("done");
    // Only the corrected call reached the dispatcher.
    expect(batches).toEqual([
      [{ id: "c2", name: "replicate_document", input: { doc_id: "doc-0", count: 2 } }],
    ]);
    expect(starts.find((c) => c.id === "c1")?.invalid).toBe(true);
    const secondPrompt = toolResultsSentIn(model.doStreamCalls[1].prompt);
    expect(secondPrompt).toContain("c1");
    expect(secondPrompt).toContain("/doc_id");
    expect(secondPrompt).toContain("Nothing ran");
  });

  it("log: an invalid call still runs with its original arguments", async () => {
    vi.stubEnv("TOOL_INPUT_VALIDATION", "log");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = await makeModel([
      callStep("c1", "replicate_document", { doc_id: "doc-0", count: "3" }),
      textStep("done"),
    ]);
    const batches: NormalizedToolCall[][] = [];
    const res = await streamAiSdk(
      {
        ...base,
        runTools: async (calls) => {
          batches.push(calls);
          return okRunTools(calls);
        },
      },
      config(model),
    );
    expect(res.fullText).toBe("done");
    expect(batches).toEqual([
      [{ id: "c1", name: "replicate_document", input: { doc_id: "doc-0", count: "3" } }],
    ]);
    expect(warn.mock.calls.some(([line]) => String(line).includes("/count type"))).toBe(true);
  });

  it("off: no check and no warning", async () => {
    vi.stubEnv("TOOL_INPUT_VALIDATION", "off");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = await makeModel([
      callStep("c1", "replicate_document", { count: 50 }),
      textStep("done"),
    ]);
    const batches: NormalizedToolCall[][] = [];
    await streamAiSdk(
      {
        ...base,
        runTools: async (calls) => {
          batches.push(calls);
          return okRunTools(calls);
        },
      },
      config(model),
    );
    expect(batches).toHaveLength(1);
    expect(warn.mock.calls.some(([line]) => String(line).includes("[tool-input]"))).toBe(false);
  });
});

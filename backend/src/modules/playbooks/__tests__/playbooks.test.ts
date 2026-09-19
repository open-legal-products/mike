import { describe, expect, it } from "vitest";
import {
  BLANK_RULE_CONCEPT,
  blankPlaybookContent,
  normalizeCompiledPlaybookOutput,
  PLAYBOOK_IMPORT_GENERIC_FAILURE,
  playbookCompilationTimeoutMs,
  playbookContentSchema,
  playbookImportFailureMessage,
  normalizeFindings,
  playbookModelAvailability,
  PlaybookRequestError,
  runFailureMessage,
  validatePlaybookCompilationWithRetry,
} from "../playbooks.operations";

function content(name = "Commercial Playbook") {
  return {
    name,
    description: "Standard commercial positions",
    globalGuidance: "Protect the customer.",
    representedParty: "Customer",
    documentTypes: ["MSA"],
    jurisdictions: ["New York"],
    topics: [
      {
        id: "liability",
        name: "Liability",
        rules: [
          {
            id: "liability-cap",
            name: "Liability cap",
            concept: "Determine whether liability is capped.",
            scope: "clause" as const,
            required: true,
            guidance: "Escalate uncapped liability.",
            standard: {
              name: "Standard",
              criteria: "Cap at fees paid in 12 months.",
              sampleClauses: [
                {
                  text: "Liability will not exceed fees paid in the preceding 12 months.",
                  usage: "preferred",
                  sourceRefs: [] as string[],
                },
              ],
            },
            fallbacks: [],
            unacceptable: [],
            // Raw model output can contain objects that normalization must handle.
            conditions: [] as unknown[],
            actions: [],
            sourceRefs: [] as string[],
          },
        ],
      },
    ],
  };
}

const oneParagraph = {
  format: "docx" as const,
  blocks: [
    {
      kind: "paragraph" as const,
      sourceRef: "P1",
      text: "Liability is capped at fees paid in the prior 12 months.",
      style: null,
      level: null,
    },
  ],
  sources: [
    {
      id: "P1",
      kind: "paragraph" as const,
      text: "Liability is capped at fees paid in the prior 12 months.",
      style: null,
      level: null,
    },
  ],
  text: "[P1] Liability is capped at fees paid in the prior 12 months.",
};

describe("playbook content validation", () => {
  it("normalizes model-generated condition objects into readable strings", () => {
    const raw = content();
    raw.topics[0].rules[0].conditions = [
      {
        when: "The supplier processes personal data",
        requirement: "A data processing addendum is required",
      },
    ];

    const parsed = playbookContentSchema.parse(
      normalizeCompiledPlaybookOutput(raw),
    );

    expect(parsed.topics[0].rules[0].conditions).toEqual([
      "When: The supplier processes personal data; Requirement: A data processing addendum is required",
    ]);
  });

  it("rejects empty playbooks and invalid clause usage", () => {
    expect(() =>
      playbookContentSchema.parse({ ...content(), topics: [] }),
    ).toThrow();
    const invalid = content();
    invalid.topics[0].rules[0].standard!.sampleClauses[0].usage =
      "sometimes";
    expect(() => playbookContentSchema.parse(invalid)).toThrow();
  });
});

describe("playbook compilation", () => {
  it("automatically retries a compilation that is not structured JSON", async () => {
    const retry = async (validationError: string) => {
      expect(validationError).toMatch(/structured JSON/i);
      const repaired = content();
      repaired.topics[0].rules[0].sourceRefs = ["P1"];
      return JSON.stringify(repaired);
    };

    const parsed = await validatePlaybookCompilationWithRetry({
      raw: "I was unable to complete the requested JSON.",
      structure: oneParagraph,
      retry,
    });

    expect(parsed.name).toBe("Commercial Playbook");
    expect(parsed.topics[0].rules[0].sourceRefs).toEqual(["P1"]);
  });

  it("reports a clear error when both compilation attempts are invalid", async () => {
    await expect(
      validatePlaybookCompilationWithRetry({
        raw: "not JSON",
        structure: { format: "docx", blocks: [], sources: [], text: "" },
        retry: async () => "still not JSON",
      }),
    ).rejects.toThrow(/invalid structured output twice/i);
  });

  it("fails a rule the model cannot tie back to the Word source", async () => {
    await expect(
      validatePlaybookCompilationWithRetry({
        raw: JSON.stringify(content()),
        structure: oneParagraph,
        retry: async () => JSON.stringify(content()),
      }),
    ).rejects.toThrow(/invalid structured output twice/i);
  });

  it("surfaces compilation failures as user-readable request errors", async () => {
    await expect(
      validatePlaybookCompilationWithRetry({
        raw: "not JSON",
        structure: { format: "docx", blocks: [], sources: [], text: "" },
        retry: async () => "still not JSON",
      }),
    ).rejects.toBeInstanceOf(PlaybookRequestError);
  });

  it("turns compilation timeouts into an actionable import error", () => {
    const timeout = Object.assign(
      new Error("The model did not respond within 300000ms."),
      { name: "TimeoutError" },
    );
    expect(playbookImportFailureMessage("compiling", timeout, 300_000)).toBe(
      "The selected model did not finish within 5 minutes. Try again or select another model.",
    );
  });

  it("does not leak an infrastructure failure into the import message", () => {
    const internal = new Error("connect ECONNREFUSED db-primary.internal:5432");
    expect(playbookImportFailureMessage("storing_source", internal)).toBe(
      PLAYBOOK_IMPORT_GENERIC_FAILURE,
    );
  });

  it("forwards a message this module wrote for the user", () => {
    expect(
      playbookImportFailureMessage(
        "checking_model",
        new PlaybookRequestError("Select a model."),
      ),
    ).toBe("Select a model.");
  });

  it("uses a longer configurable timeout for playbook compilation", () => {
    expect(playbookCompilationTimeoutMs("")).toBe(300_000);
    expect(playbookCompilationTimeoutMs("600000")).toBe(600_000);
    expect(playbookCompilationTimeoutMs("invalid")).toBe(300_000);
  });
});

describe("playbook model availability", () => {
  it("accepts a built-in model once its provider key is saved", () => {
    expect(
      playbookModelAvailability("claude-haiku-4-5", { claude: "sk-ant" }),
    ).toEqual({ available: true });
    expect(playbookModelAvailability("claude-haiku-4-5", {})).toMatchObject({
      available: false,
      reason: expect.stringMatching(/Anthropic \(Claude\) API key/i),
    });
  });

  it("accepts dynamic OpenRouter models when the router key is saved", () => {
    expect(
      playbookModelAvailability("openrouter/anthropic/claude-sonnet-4", {
        openrouter: "sk-or-user",
      }),
    ).toEqual({ available: true });
    expect(
      playbookModelAvailability("openrouter/anthropic/claude-sonnet-4", {}),
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/OpenRouter API key/i),
    });
  });

  it("accepts local Ollama models without any key", () => {
    expect(playbookModelAvailability("ollama/qwen3.6", {})).toEqual({
      available: true,
    });
  });

  it("reports an unknown model id instead of throwing", () => {
    expect(playbookModelAvailability("not-a-model", {})).toMatchObject({
      available: false,
      reason: expect.stringMatching(/unknown model id/i),
    });
  });
});

describe("review finding normalization", () => {
  const published = playbookContentSchema.parse(content());

  function finding(overrides: Record<string, unknown> = {}) {
    return {
      topicId: null,
      ruleId: null,
      ruleName: "Liability cap",
      status: "unacceptable" as const,
      quote: "",
      location: "",
      analysis: "The cap is uncapped.",
      suggestedText: "Cap at fees paid.",
      ...overrides,
    };
  }

  it("keeps a finding that identifies its rule by name instead of id", () => {
    const [first, ...rest] = normalizeFindings(published, "", [finding()]);

    expect(rest).toHaveLength(0);
    expect(first).toMatchObject({
      ruleId: "liability-cap",
      topicId: "liability",
      ruleName: "Liability cap",
      status: "unacceptable",
      analysis: "The cap is uncapped.",
      suggestedText: "Cap at fees paid.",
    });
  });

  it("matches a rule name regardless of case and surrounding space", () => {
    const [first] = normalizeFindings(published, "", [
      finding({ ruleName: "  liability CAP  " }),
    ]);

    expect(first).toMatchObject({ ruleId: "liability-cap" });
  });

  it("prefers a valid ruleId over the rule name", () => {
    const [first] = normalizeFindings(published, "", [
      finding({ ruleId: "liability-cap", ruleName: "Something else" }),
    ]);

    expect(first).toMatchObject({ ruleId: "liability-cap" });
  });

  it("back-fills a rule the model did not answer", () => {
    const [first] = normalizeFindings(published, "", []);

    expect(first).toMatchObject({
      ruleId: "liability-cap",
      status: "needs_review",
    });
    expect(first.analysis).toMatch(/did not return a result/i);
  });

  it("does not guess when two rules share a name", () => {
    const ambiguous = playbookContentSchema.parse({
      ...content(),
      topics: [
        {
          id: "liability",
          name: "Liability",
          rules: [
            { ...content().topics[0].rules[0], id: "rule-a" },
            { ...content().topics[0].rules[0], id: "rule-b" },
          ],
        },
      ],
    });

    const normalized = normalizeFindings(ambiguous, "", [finding()]);

    expect(normalized.every((entry) => entry.status === "needs_review")).toBe(
      true,
    );
  });
});

describe("run failure messages", () => {
  it("passes through a message this module wrote", () => {
    expect(runFailureMessage(new PlaybookRequestError("Select a model."))).toBe(
      "Select a model.",
    );
  });

  it.each([
    ["a provider exception", new Error("invalid x-api-key sk-ant-secret123456")],
    ["a database error", { code: "42P01", message: 'relation "x" does not exist' }],
    ["a non-error value", "raw string failure"],
  ])("does not pass through %s", (_label, error) => {
    const message = runFailureMessage(error);

    expect(message).toBe("The review failed. Try again.");
    expect(message).not.toMatch(/sk-ant|x-api-key|relation|raw string/);
  });

  it("explains a timeout", () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";

    expect(runFailureMessage(error)).toMatch(/timed out/i);
  });
});

describe("a playbook started without a Word file", () => {
  it("produces content the schema accepts", () => {
    const content = blankPlaybookContent("Vendor MSA playbook");

    expect(() => playbookContentSchema.parse(content)).not.toThrow();
    expect(content.name).toBe("Vendor MSA playbook");
  });

  it("gives the first rule a concept, because the schema requires one", () => {
    const [rule] = blankPlaybookContent("P").topics[0].rules;

    expect(rule.concept).toBe(BLANK_RULE_CONCEPT);
    expect(rule.concept.trim().length).toBeGreaterThan(0);
  });

  it("starts with one topic and one rule", () => {
    const content = blankPlaybookContent("P");

    expect(content.topics).toHaveLength(1);
    expect(content.topics[0].rules).toHaveLength(1);
  });

  it("carries no source references, unlike a compiled import", () => {
    const [rule] = blankPlaybookContent("P").topics[0].rules;

    expect(rule.sourceRefs).toEqual([]);
  });
});

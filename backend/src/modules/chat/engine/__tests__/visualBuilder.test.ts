import { describe, expect, it, vi } from "vitest";
import { runVisualBuild, type VisualBuildRun } from "../tools/visualBuilder";

const run: VisualBuildRun = {
  title: "Lease dates",
  task: "Show the dates.",
  system: "",
  message: "Show the dates.",
  docStore: new Map(),
  docIndex: {},
  documentsScoped: false,
  save: async () => "",
  saved: () => false,
};

describe("runVisualBuild", () => {
  it("reports a builder that replies without saving as failed", async () => {
    const result = await runVisualBuild(run, {
      model: "m",
      reasoning: "high",
      write: vi.fn(),
      spawn: async () => ({ fullText: "The documents give no dates.", events: [] }),
    });

    expect(result).toMatchObject({ status: "failed", report: "The documents give no dates." });
    expect(result.event).toMatchObject({ type: "delegation", kind: "visual", task: "Show the dates.", status: "failed" });
  });

  it("reports a builder that uses every step without saving as incomplete at its step limit", async () => {
    const result = await runVisualBuild(run, {
      model: "m",
      reasoning: "high",
      write: vi.fn(),
      spawn: async ({ maxSteps, onUsage }) => {
        for (let i = 0; i < maxSteps; i++) onUsage({ inputTokens: 1, outputTokens: 1 }, "tool-calls");
        return { fullText: "", events: [] };
      },
    });

    expect(result).toMatchObject({ status: "incomplete", limit: "step" });
  });
});

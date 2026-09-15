import { describe, expect, it } from "vitest";
import {
  normalizeWorkflowName,
  workflowNameFromSkillMd,
} from "../workflows.name";

describe("normalizeWorkflowName", () => {
  it("accepts lowercase workflow names", () => {
    expect(normalizeWorkflowName(" contract-intake ")).toBe(
      "contract-intake",
    );
  });

  it("rejects invalid workflow names", () => {
    expect(normalizeWorkflowName("/contract-intake")).toBeNull();
    expect(normalizeWorkflowName("Contract Intake")).toBeNull();
  });
});

describe("workflowNameFromSkillMd", () => {
  it("reads name from skill frontmatter", () => {
    expect(
      workflowNameFromSkillMd(`---
name: contract-intake
metadata:
  mike-display-name: "Contract Intake"
---
# Contract Intake`),
    ).toBe("contract-intake");
  });

  it("ignores a name nested inside metadata", () => {
    expect(
      workflowNameFromSkillMd(`---
metadata:
  name: contract-intake
  mike-display-name: "Contract Intake"
---`),
    ).toBeNull();
  });
});

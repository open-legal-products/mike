import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/app/components/ui/toast";
import type { PlaybookContent, PlaybookRule } from "@/app/lib/mikeApi";
import { PlaybookEditor } from "./PlaybookEditor";
import { clauseUsageConflict, describeSourceRefs } from "./PlaybookRuleForm";

const baseRule = (id: string): PlaybookRule => ({
  id,
  name: id,
  concept: `Concept ${id}`,
  guidance: "",
  scope: "clause",
  required: false,
  standard: null,
  fallbacks: [],
  unacceptable: [],
  conditions: [],
  actions: [],
  sourceRefs: [],
});

function Harness({
  rule,
  changed = vi.fn(),
}: {
  rule: PlaybookRule;
  changed?: (content: PlaybookContent) => void;
}) {
  const [content, setContent] = useState<PlaybookContent>({
    name: "Guide",
    description: "",
    representedParty: "",
    documentTypes: [],
    jurisdictions: [],
    rules: [rule, baseRule("Other")],
    topics: [],
  });
  const [selected, setSelected] = useState<string | null>(rule.id);
  return (
    <>
      <PlaybookEditor
        content={content}
        onChange={(next) => {
          changed(next);
          setContent(next);
        }}
        selectedRuleId={selected}
        onSelectRule={setSelected}
        disabled={false}
      />
      <ToastViewportUI />
    </>
  );
}

function lastRule(changed: ReturnType<typeof vi.fn>, id = "Alpha") {
  const content = changed.mock.lastCall?.[0] as PlaybookContent;
  return content.rules!.find((rule) => rule.id === id)!;
}

afterEach(() => clearToasts());

const openTab = (name: "Overview" | "Positions" | "Escalation") =>
  userEvent.click(
    within(screen.getByRole("group", { name: "Rule sections" })).getByRole(
      "button",
      { name },
    ),
  );

describe("playbook rule form", () => {
  it("chooses whether the rule is required from a dropdown", async () => {
    const changed = vi.fn();
    render(<Harness rule={baseRule("Alpha")} changed={changed} />);
    const select = screen.getByLabelText("Requirement");
    expect(select).toHaveTextContent("Optional");
    expect(
      screen.getByText(/doesn’t flag the contract when this term is absent/),
    ).toBeVisible();
    await userEvent.click(select);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Required" }),
    );
    expect(lastRule(changed).required).toBe(true);
    expect(select).toHaveTextContent("Required");
    expect(screen.getByText(/flags it as missing/)).toBeVisible();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("explains fields below them instead of with example text", () => {
    render(<Harness rule={baseRule("Alpha")} />);
    expect(
      screen.getByLabelText("Concept to detect"),
    ).toHaveAccessibleDescription(
      "Describe the term so the review can find it in any contract.",
    );
    expect(
      screen.getByLabelText("Applies only when"),
    ).toHaveAccessibleDescription(
      "One condition per line. Leave empty if the rule always applies.",
    );
    for (const label of [
      "Concept to detect",
      "Applies only when",
      "Additional guidance",
    ])
      expect(screen.getByLabelText(label)).not.toHaveAttribute("placeholder");
  });

  it("edits conditions one per line without saving blank lines", async () => {
    const changed = vi.fn();
    render(
      <Harness
        rule={{ ...baseRule("Alpha"), conditions: ["Fees exceed $100k"] }}
        changed={changed}
      />,
    );
    const field = screen.getByLabelText("Applies only when");
    expect(field).toHaveValue("Fees exceed $100k");
    await userEvent.type(field, "{Enter}");
    expect(field).toHaveValue("Fees exceed $100k\n");
    expect(changed).not.toHaveBeenCalled();
    await userEvent.type(field, "  Term over 3 years ");
    expect(lastRule(changed).conditions).toEqual([
      "Fees exceed $100k",
      "Term over 3 years",
    ]);
  });

  it("saves an escalation only once it says what to do", async () => {
    const changed = vi.fn();
    render(
      <Harness
        rule={{
          ...baseRule("Alpha"),
          actions: [{ scenario: "No cap", instruction: "Ask the GC" }],
        }}
        changed={changed}
      />,
    );
    await openTab("Escalation");
    expect(screen.getByLabelText("Then")).toHaveValue("Ask the GC");
    await userEvent.click(
      screen.getByRole("button", { name: "Add escalation" }),
    );
    const second = screen.getByRole("group", { name: "Escalation 2" });
    await userEvent.type(within(second).getByLabelText("When"), "Uncapped");
    expect(changed).not.toHaveBeenCalled();
    expect(second).not.toHaveTextContent("Saved once “Then” is filled in.");
    await userEvent.type(within(second).getByLabelText("Then"), "Refuse");
    expect(lastRule(changed).actions).toEqual([
      { scenario: "No cap", instruction: "Ask the GC" },
      { scenario: "Uncapped", instruction: "Refuse" },
    ]);
  });

  it("duplicates and deletes an escalation from its card menu", async () => {
    const changed = vi.fn();
    render(
      <Harness
        rule={{
          ...baseRule("Alpha"),
          actions: [
            { scenario: "No cap", instruction: "Ask the GC" },
            { scenario: "Uncapped indemnity", instruction: "Refuse" },
          ],
        }}
        changed={changed}
      />,
    );
    await openTab("Escalation");
    expect(screen.queryByLabelText("Topic")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for escalation 1" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(lastRule(changed).actions).toEqual([
      { scenario: "No cap", instruction: "Ask the GC" },
      { scenario: "No cap", instruction: "Ask the GC" },
      { scenario: "Uncapped indemnity", instruction: "Refuse" },
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for escalation 3" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(lastRule(changed).actions).toEqual([
      { scenario: "No cap", instruction: "Ask the GC" },
      { scenario: "No cap", instruction: "Ask the GC" },
    ]);
    expect(
      screen.queryByRole("button", { name: /Remove escalation/ }),
    ).toBeNull();
  });

  it("removes a position with an undo that restores it after later edits", async () => {
    const changed = vi.fn();
    render(
      <Harness
        rule={{
          ...baseRule("Alpha"),
          fallbacks: [
            { name: "Higher cap", criteria: "2x fees", sampleClauses: [] },
            { name: "Mutual cap", criteria: "Mutual", sampleClauses: [] },
          ],
        }}
        changed={changed}
      />,
    );
    await openTab("Positions");
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Fallback 1" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Remove position" }),
    );
    expect(lastRule(changed).fallbacks.map((p) => p.name)).toEqual([
      "Mutual cap",
    ]);
    expect(screen.getByText("Removed Fallback 1.")).toBeVisible();

    await openTab("Overview");
    await userEvent.type(screen.getByLabelText("Additional guidance"), "Later");
    await userEvent.click(screen.getByRole("button", { name: "Other" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Positions" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const restored = lastRule(changed);
    expect(restored.fallbacks.map((p) => p.name)).toEqual([
      "Higher cap",
      "Mutual cap",
    ]);
    expect(restored.guidance).toBe("Later");
    expect(screen.getByLabelText("Rule")).toHaveValue("Alpha");
  });

  it("removes an empty position without offering undo", async () => {
    render(<Harness rule={baseRule("Alpha")} />);
    await openTab("Positions");
    const standardGroup = screen.getByRole("region", {
      name: "Standard position",
    });
    await userEvent.click(
      within(standardGroup).getByRole("button", { name: "Add" }),
    );
    expect(
      within(standardGroup).queryByRole("button", { name: "Add" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Standard" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Remove position" }),
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(standardGroup).getByText("None yet.")).toBeVisible();
  });

  it("reorders fallbacks from the position menu", async () => {
    const changed = vi.fn();
    render(
      <Harness
        rule={{
          ...baseRule("Alpha"),
          fallbacks: [
            { name: "First", criteria: "", sampleClauses: [] },
            { name: "Second", criteria: "", sampleClauses: [] },
          ],
        }}
        changed={changed}
      />,
    );
    await openTab("Positions");
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Fallback 1" }),
    );
    expect(screen.getByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
    expect(lastRule(changed).fallbacks.map((p) => p.name)).toEqual([
      "Second",
      "First",
    ]);
  });

  it("defaults a new clause's usage to its position and flags contradictions", async () => {
    const changed = vi.fn();
    render(
      <Harness
        rule={{
          ...baseRule("Alpha"),
          standard: {
            name: "Standard",
            criteria: "Cap",
            sampleClauses: [
              { text: "Uncapped", usage: "unacceptable", sourceRefs: [] },
            ],
          },
          unacceptable: [{ name: "No cap", criteria: "", sampleClauses: [] }],
        }}
        changed={changed}
      />,
    );
    await openTab("Positions");
    const standard = screen.getByRole("group", { name: "Standard" });
    expect(
      within(standard).getByLabelText("Clause 1"),
    ).toHaveAccessibleDescription("Conflicts with this acceptable position.");
    const unacceptable = screen.getByRole("group", { name: "Unacceptable 1" });
    await userEvent.click(
      within(unacceptable).getByRole("button", { name: "Add clause" }),
    );
    expect(lastRule(changed).unacceptable[0].sampleClauses).toEqual([
      { text: "", usage: "unacceptable", sourceRefs: [] },
    ]);
  });

  it("dismisses pending undo notices when the editor closes", async () => {
    const { unmount } = render(
      <Harness
        rule={{
          ...baseRule("Alpha"),
          standard: { name: "Standard", criteria: "Cap", sampleClauses: [] },
        }}
      />,
    );
    await openTab("Positions");
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Standard" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Remove position" }),
    );
    expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();
    unmount();
    render(<ToastViewportUI />);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("rule form helpers", () => {
  it("writes source markers out for people", () => {
    expect(describeSourceRefs(["P4", "T2R3C1", "custom"])).toBe(
      "paragraph 4; table 2, row 3, cell 1; custom",
    );
  });

  it("flags usages that contradict their position", () => {
    expect(clauseUsageConflict("standard", "preferred")).toBeNull();
    expect(clauseUsageConflict("fallbacks", "unacceptable")).not.toBeNull();
    expect(clauseUsageConflict("unacceptable", "accepted")).not.toBeNull();
    expect(clauseUsageConflict("unacceptable", "illustrative")).toBeNull();
  });
});

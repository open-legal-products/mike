import { useState } from "react";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlaybookContent, PlaybookRule } from "@/app/lib/mikeApi";
import { PlaybookEditor } from "./PlaybookEditor";

const rule = (id: string): PlaybookRule => ({
  id,
  name: id,
  concept: `Concept ${id}`,
  guidance: `Guidance ${id}`,
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
  disabled = false,
  changed = vi.fn(),
  initialRules = [rule("Alpha"), rule("Beta")],
}: {
  disabled?: boolean;
  changed?: (content: PlaybookContent) => void;
  initialRules?: PlaybookRule[];
}) {
  const [content, setContent] = useState<PlaybookContent>({
    name: "Guide",
    description: "",
    representedParty: "",
    documentTypes: [],
    jurisdictions: [],
    rules: initialRules,
    topics: [{ id: "group", name: "Commercial", rules: [rule("Gamma")] }],
  });
  const [selected, setSelected] = useState<string | null>("Alpha");
  return (
    <PlaybookEditor
      content={content}
      onChange={(next) => {
        changed(next);
        setContent(next);
      }}
      selectedRuleId={selected}
      onSelectRule={setSelected}
      disabled={disabled}
    />
  );
}
function transfer() {
  const data = new Map<string, string>();
  return {
    types: [] as string[],
    effectAllowed: "none",
    dropEffect: "none",
    setDragImage: vi.fn(),
    setData(type: string, value: string) {
      this.types.push(type);
      data.set(type, value);
    },
    getData(type: string) {
      return data.get(type) ?? "";
    },
  };
}

describe("playbook rules sidebar", () => {
  it("does not activate an action when the opening right-click is released over it", async () => {
    const changed = vi.fn();
    render(<Harness changed={changed} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
    const duplicate = screen.getByRole("menuitem", { name: "Duplicate rule" });
    fireEvent.pointerUp(duplicate, { button: 2, pointerType: "mouse" });
    expect(changed).not.toHaveBeenCalled();
    expect(duplicate).toBeVisible();
    await userEvent.click(duplicate);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("offers the topic context actions from its row menu and adds a rule to that topic", async () => {
    const changed = vi.fn();
    render(<Harness changed={changed} />);
    fireEvent.contextMenu(screen.getByLabelText("Topic 1 name"));
    const actions = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse topic Commercial" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Topic actions for Commercial" }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(actions);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add rule" }));
    const next = changed.mock.lastCall?.[0] as PlaybookContent;
    expect(next.rules!.map((entry) => entry.id)).toEqual(["Alpha", "Beta"]);
    expect(next.topics[0].rules.map((entry) => entry.name)).toEqual([
      "Gamma",
      "New rule 4",
    ]);
    expect(screen.getByRole("button", { name: "New rule 4" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Collapse topic Commercial" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a rule row's actions without selecting it and deletes that rule", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", {
      name: "Rule actions for Beta",
    });
    expect(trigger.closest("button[aria-pressed]")).toBeNull();
    await userEvent.click(trigger);
    const actions = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(screen.getByLabelText("Rule")).toHaveValue("Alpha");
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(actions);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(trigger);
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete rule" }),
    );
    expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
    expect(screen.getByLabelText("Rule")).toHaveValue("Alpha");
  });

  it("keeps mutations disabled in topic and rule row menus for readers", async () => {
    const changed = vi.fn();
    render(<Harness disabled changed={changed} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Topic actions for Commercial" }),
    );
    expect(screen.getByRole("menuitem", { name: "Add rule" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Add rule" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      screen.getByRole("button", { name: "Rule actions for Beta" }),
    );
    for (const name of ["Duplicate rule", "Delete rule"]) {
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete rule" }),
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(["Alpha", "Gamma"])(
    "keeps an unnamed %s rule visible and editable",
    async (name) => {
      render(<Harness />);
      await userEvent.click(screen.getByRole("button", { name }));
      const input = screen.getByLabelText("Rule");
      await userEvent.clear(input);
      expect(input).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Untitled rule" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.getByRole("button", { name: "Untitled rule" }),
      ).toHaveAttribute("title", "Untitled rule");
      expect(input).toHaveAttribute("placeholder", "Untitled rule");
      await userEvent.type(input, "   ");
      expect(
        screen.getByRole("button", { name: "Untitled rule" }),
      ).toBeVisible();
      await userEvent.clear(input);
      await userEvent.type(input, "Renamed rule");
      expect(
        screen.getByRole("button", { name: "Renamed rule" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.queryByRole("button", { name: "Untitled rule" }),
      ).toBeNull();
    },
  );

  it("offers the same creation actions on the background and header menu", async () => {
    render(<Harness />);
    const sidebar = screen.getByRole("region", { name: "Topics and rules" });
    fireEvent.contextMenu(sidebar, { clientX: 30, clientY: 50 });
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Add rule", "Add topic"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add topic" }));
    expect(screen.getByLabelText("Topic 2 name")).toHaveValue("New topic");
    await userEvent.click(
      screen.getByRole("button", { name: "Rules actions" }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Add rule", "Add topic"]);
  });

  it("deletes the right-clicked rule while keeping a different selected rule", async () => {
    const changed = vi.fn();
    render(<Harness changed={changed} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete rule" }),
    );
    expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
    expect(screen.getByLabelText("Rule")).toHaveValue("Alpha");
    expect(
      changed.mock.lastCall?.[0].rules.map((entry: PlaybookRule) => entry.id),
    ).toEqual(["Alpha"]);
  });

  it("duplicates a complete rule beside its source and edits the copy independently", async () => {
    const source: PlaybookRule = {
      ...rule("Alpha"),
      scope: "agreement",
      required: true,
      standard: {
        name: "Standard",
        criteria: "Limit liability",
        sampleClauses: [
          { text: "Cap", usage: "preferred", sourceRefs: ["p1"] },
        ],
      },
      fallbacks: [
        { name: "Fallback", criteria: "Higher cap", sampleClauses: [] },
      ],
      unacceptable: [{ name: "Reject", criteria: "No cap", sampleClauses: [] }],
      conditions: ["If mutual"],
      actions: [{ scenario: "Missing", instruction: "Add a cap" }],
      sourceRefs: ["p1"],
    };
    const changed = vi.fn();
    render(<Harness changed={changed} initialRules={[source, rule("Beta")]} />);
    await userEvent.click(screen.getByRole("button", { name: "Rule actions" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Duplicate rule" }),
    );
    const next = changed.mock.lastCall?.[0] as PlaybookContent;
    const copy = next.rules![1];
    expect(next.rules!.map((entry) => entry.name)).toEqual([
      "Alpha",
      "Alpha (copy)",
      "Beta",
    ]);
    expect(copy).toEqual({
      ...source,
      id: expect.any(String),
      name: "Alpha (copy)",
    });
    expect(copy.id).not.toBe(source.id);
    expect(copy.standard?.sampleClauses).not.toBe(
      source.standard?.sampleClauses,
    );
    expect(
      screen.getByRole("button", { name: "Alpha (copy)" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(
      screen.getByLabelText("Additional guidance"),
      " updated",
    );
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.getByLabelText("Additional guidance")).toHaveValue(
      source.guidance,
    );
  });

  it("keeps the open rule's menu to the rule itself and duplicates into the original topic", async () => {
    const changed = vi.fn();
    render(<Harness changed={changed} />);
    await userEvent.click(screen.getByRole("button", { name: "Gamma" }));
    await userEvent.click(screen.getByRole("button", { name: "Rule actions" }));
    // The open rule's menu acts on the rule itself; the list does the rest.
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Duplicate rule", "Delete rule"]);
    // Each with its icon.
    for (const item of screen.getAllByRole("menuitem"))
      expect(item.querySelector("svg")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Gamma" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Duplicate rule",
      "Move out of topic",
      "Delete rule",
    ]);
    // The list's menus carry icons too, on every item.
    for (const item of screen.getAllByRole("menuitem"))
      expect(item.querySelector("svg")).not.toBeNull();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Duplicate rule" }),
    );
    const next = changed.mock.lastCall?.[0] as PlaybookContent;
    expect(next.rules!.map((entry) => entry.id)).toEqual(["Alpha", "Beta"]);
    expect(next.topics[0].rules.map((entry) => entry.name)).toEqual([
      "Gamma",
      "Gamma (copy)",
    ]);
    expect(next.topics[0].rules[1].id).not.toBe("Gamma");
    expect(screen.getByLabelText("Rule")).toHaveValue("Gamma (copy)");
    await userEvent.click(screen.getByRole("button", { name: "Rule actions" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete rule" }),
    );
    expect(screen.queryByRole("button", { name: "Gamma (copy)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Gamma" })).toBeInTheDocument();
  });

  it("leaves reordering and grouping to dragging", () => {
    render(<Harness />);
    expect(screen.queryByLabelText("Topic", { exact: true })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Beta" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Duplicate rule", "Delete rule"]);
  });

  it("opens a rule's menu from the keyboard and removes a topic without deleting its rules", async () => {
    render(<Harness />);
    const beta = screen.getByRole("button", { name: "Beta" });
    beta.focus();
    fireEvent.keyDown(beta, { key: "F10", shiftKey: true });
    expect(
      screen.getByRole("menuitem", { name: "Duplicate rule" }),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    fireEvent.contextMenu(screen.getByLabelText("Topic 1 name"));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Remove topic (keep rules)" }),
    );
    expect(screen.queryByLabelText("Topic 1 name")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Gamma" }));
    expect(screen.getByLabelText("Additional guidance")).toHaveValue(
      "Guidance Gamma",
    );
  });

  it("drags rules into a collapsed topic, between rows, and back to the root", () => {
    const changed = vi.fn();
    render(<Harness changed={changed} />);
    const sidebar = screen.getByRole("region", { name: "Topics and rules" });
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse topic Commercial" }),
    );
    const dataTransfer = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Beta" }), {
      dataTransfer,
    });
    const topic = screen.getByLabelText("Topic 1 name").parentElement!;
    fireEvent.dragOver(topic, { dataTransfer });
    fireEvent.drop(topic, { dataTransfer });
    expect(
      changed.mock.lastCall?.[0].topics[0].rules.map(
        (entry: PlaybookRule) => entry.id,
      ),
    ).toEqual(["Gamma", "Beta"]);
    expect(
      screen.getByRole("button", { name: "Collapse topic Commercial" }),
    ).toHaveAttribute("aria-expanded", "true");
    fireEvent.dragStart(screen.getByRole("button", { name: "Beta" }), {
      dataTransfer,
    });
    const gamma = screen.getByRole("button", { name: "Gamma" });
    vi.spyOn(gamma, "getBoundingClientRect").mockReturnValue({
      top: 10,
      height: 20,
    } as DOMRect);
    for (const type of ["dragOver", "drop"] as const) {
      const event = createEvent[type](gamma, { dataTransfer });
      Object.defineProperty(event, "clientY", { value: 11 });
      fireEvent(gamma, event);
    }
    expect(
      changed.mock.lastCall?.[0].topics[0].rules.map(
        (entry: PlaybookRule) => entry.id,
      ),
    ).toEqual(["Beta", "Gamma"]);
    fireEvent.dragStart(screen.getByRole("button", { name: "Beta" }), {
      dataTransfer,
    });
    fireEvent.drop(sidebar, { dataTransfer });
    expect(
      changed.mock.lastCall?.[0].rules.map((entry: PlaybookRule) => entry.id),
    ).toEqual(["Alpha", "Beta"]);
    expect(screen.getByLabelText("Additional guidance")).toHaveValue(
      "Guidance Beta",
    );
  });

  it("switches rule sections with tabs that stay put across rules and for readers", async () => {
    render(<Harness disabled />);
    const sections = screen.getByRole("group", { name: "Rule sections" });
    const overview = within(sections).getByRole("button", { name: "Overview" });
    const positions = within(sections).getByRole("button", {
      name: "Positions",
    });
    expect(overview).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Concept to detect")).toBeDisabled();
    await userEvent.click(positions);
    expect(positions).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Concept to detect")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Fallback positions" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(positions).toHaveAttribute("aria-pressed", "true");
  });

  it("blocks mutations for readers and ignores external drags", async () => {
    const changed = vi.fn();
    const { rerender } = render(<Harness disabled changed={changed} />);
    const alpha = screen.getByRole("button", { name: "Alpha" });
    expect(alpha).toHaveAttribute("draggable", "false");
    expect(screen.getByRole("button", { name: "Rule actions" })).toBeDisabled();
    fireEvent.contextMenu(alpha);
    for (const label of [
      "Duplicate rule",
      "Delete rule",
    ]) {
      expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete rule" }),
    );
    expect(changed).not.toHaveBeenCalled();
    // Adding lives in the list's own menu, closed to readers too.
    await userEvent.click(screen.getByRole("button", { name: "Rules actions" }));
    for (const label of ["Add rule", "Add topic"])
      expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    await userEvent.keyboard("{Escape}");
    rerender(<Harness changed={changed} />);
    const dataTransfer = transfer();
    dataTransfer.setData("application/x-mike-playbook-rule", "Alpha");
    fireEvent.drop(screen.getByRole("region", { name: "Topics and rules" }), {
      dataTransfer,
    });
    expect(changed).not.toHaveBeenCalled();
  });
});

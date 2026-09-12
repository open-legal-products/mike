import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { WorkflowPromptEditor } from "./WorkflowPromptEditor";

const mocks = vi.hoisted(() => {
  const chain = {
    focus: vi.fn(),
    setTextSelection: vi.fn(),
    insertTable: vi.fn(),
    run: vi.fn(),
  };
  chain.focus.mockReturnValue(chain);
  chain.setTextSelection.mockReturnValue(chain);
  chain.insertTable.mockReturnValue(chain);
  chain.run.mockReturnValue(true);

  return {
    chain,
    editor: {
      isDestroyed: false,
      state: { selection: { from: 4, to: 9 } },
      storage: { markdown: { getMarkdown: () => "Prompt" } },
      commands: { setContent: vi.fn() },
      setEditable: vi.fn(),
      chain: vi.fn(() => chain),
      isActive: vi.fn(() => false),
    },
  };
});

vi.mock("@tiptap/react", () => ({
  useEditor: () => mocks.editor,
  useEditorState: () => undefined,
  EditorContent: () => <div data-testid="editor-content" />,
}));

vi.mock("@tiptap/starter-kit", () => ({
  default: { configure: vi.fn(() => ({})) },
}));

vi.mock("@tiptap/extension-table", () => ({
  TableKit: { configure: vi.fn(() => ({})) },
}));

vi.mock("tiptap-markdown", () => ({
  Markdown: { configure: vi.fn(() => ({})) },
}));

describe("WorkflowPromptEditor table picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chain.focus.mockReturnValue(mocks.chain);
    mocks.chain.setTextSelection.mockReturnValue(mocks.chain);
    mocks.chain.insertTable.mockReturnValue(mocks.chain);
    mocks.chain.run.mockReturnValue(true);
    mocks.editor.chain.mockReturnValue(mocks.chain);
  });

  it("preserves the workflow surface while using the shared editor", async () => {
    const user = userEvent.setup();
    const { container } = render(
      withIntl(<WorkflowPromptEditor value="Prompt" onChange={vi.fn()} />),
    );

    expect(container.firstElementChild).toHaveClass(
      "rounded-2xl",
      "liquid-glass-flat",
    );

    await user.click(screen.getByRole("button", { name: "Inserir tabela" }));
    const gridCell = screen.getByRole("menuitem", {
      name: "Inserir tabela de 3 por 4",
    });
    await user.hover(gridCell);
    expect(screen.getByText("3 x 4")).toBeVisible();

    await user.click(gridCell);

    expect(mocks.chain.setTextSelection).toHaveBeenCalledWith({
      from: 4,
      to: 9,
    });
    expect(mocks.chain.insertTable).toHaveBeenCalledWith({
      rows: 3,
      cols: 4,
      withHeaderRow: true,
    });
  });
});

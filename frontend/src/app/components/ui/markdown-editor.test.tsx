import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { MarkdownEditor } from "./markdown-editor";

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
    useEditor: vi.fn(),
    editor: {
      isDestroyed: false,
      state: { selection: { from: 4, to: 9 } },
      storage: { markdown: { getMarkdown: (): string => "Prompt" } },
      commands: { setContent: vi.fn() },
      setEditable: vi.fn(),
      chain: vi.fn(() => chain),
      isActive: vi.fn(() => false),
    },
  };
});

mocks.useEditor.mockReturnValue(mocks.editor);

vi.mock("@tiptap/react", () => ({
  useEditor: mocks.useEditor,
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

describe("MarkdownEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chain.focus.mockReturnValue(mocks.chain);
    mocks.chain.setTextSelection.mockReturnValue(mocks.chain);
    mocks.chain.insertTable.mockReturnValue(mocks.chain);
    mocks.chain.run.mockReturnValue(true);
    mocks.editor.chain.mockReturnValue(mocks.chain);
    mocks.useEditor.mockReturnValue(mocks.editor);
    mocks.editor.storage.markdown.getMarkdown = () => "Prompt";
  });

  it("selects a grid size and inserts at the saved editor selection", async () => {
    const user = userEvent.setup();
    const { container } = render(
      withIntl(<MarkdownEditor
        value="Prompt"
        onChange={vi.fn()}
        ariaLabel="Memory document"
        className="workflow-prompt-editor"
      />),
    );

    expect(container.firstElementChild).toHaveClass(
      "workflow-prompt-editor",
      "rounded-2xl",
      "liquid-glass-flat",
    );
    // Not a table: a surface being typed into stays visually raised while
    // table containers are intentionally transparent.
    expect(container.firstElementChild).not.toHaveClass("table-surface");

    expect(
      screen.getByRole("toolbar", { name: "Formatação Markdown" }),
    ).toBeVisible();

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

  it("dims a suspended editor instead of calling it read-only", () => {
    const { container } = render(
      withIntl(<MarkdownEditor value="Prompt" ariaLabel="Memory document" suspended />),
    );

    // A pending confirmation says nothing about the reader's rights, so the
    // toolbar stays put and the "Read-only" bar never appears.
    expect(
      screen.getByRole("toolbar", { name: "Formatação Markdown" }),
    ).toBeVisible();
    expect(screen.queryByText("Somente leitura")).toBeNull();

    expect(screen.getByRole("button", { name: "Título 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Inserir tabela" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Mostrar Markdown bruto" }),
    ).toBeDisabled();
    expect(mocks.editor.setEditable).toHaveBeenLastCalledWith(false, false);
    expect(
      container.querySelector(".flex-1.overflow-y-auto"),
    ).toHaveClass("opacity-50");
  });

  it("withholds the table control when tables are not allowed", () => {
    render(
      withIntl(<MarkdownEditor
        value="Prompt"
        ariaLabel="Memory document"
        allowTables={false}
      />),
    );

    expect(
      screen.getByRole("toolbar", { name: "Formatação Markdown" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Inserir tabela" })).toBeNull();
    expect(screen.getByRole("button", { name: "Título 1" })).toBeVisible();
  });

  it("names the rich and raw editors and gives raw mode a focus indicator", async () => {
    const user = userEvent.setup();
    render(withIntl(<MarkdownEditor value="Prompt" ariaLabel="Memory document" />));

    expect(mocks.useEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        editorProps: {
          attributes: expect.objectContaining({
            "aria-label": "Memory document",
            class: "tiptap markdown-editor-content",
          }),
        },
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Mostrar Markdown bruto" }),
    );
    expect(
      screen.getByRole("textbox", {
        name: "Memory document (Markdown bruto)",
      }),
    ).toHaveClass("focus-visible:ring-2");
  });

  it("activates toolbar controls from the keyboard", async () => {
    const user = userEvent.setup();
    render(withIntl(<MarkdownEditor value="Prompt" ariaLabel="Memory document" />));

    const rawToggle = screen.getByRole("button", {
      name: "Mostrar Markdown bruto",
    });
    rawToggle.focus();
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("textbox", {
        name: "Memory document (Markdown bruto)",
      }),
    ).toBeVisible();
  });

  it("syncs external values in raw mode and updates editability", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      withIntl(<MarkdownEditor value="Prompt" ariaLabel="Memory document" />),
    );
    await user.click(
      screen.getByRole("button", { name: "Mostrar Markdown bruto" }),
    );

    rerender(
      withIntl(<MarkdownEditor
        value="Latest value"
        ariaLabel="Memory document"
        readOnly
      />),
    );

    expect(mocks.editor.commands.setContent).toHaveBeenCalledWith(
      "Latest value",
      { emitUpdate: false },
    );
    expect(mocks.editor.setEditable).toHaveBeenLastCalledWith(false, false);
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", {
          name: "Memory document (Markdown bruto)",
        }),
      ).toHaveValue("Latest value"),
    );
  });

  it("keeps lossy Markdown in raw mode instead of rewriting it", async () => {
    mocks.editor.storage.markdown.getMarkdown = () => "plain text";

    render(
      withIntl(<MarkdownEditor
        value={"![diagram](diagram.png)\n\nplain text"}
        ariaLabel="Memory document"
      />),
    );

    expect(
      await screen.findByRole("textbox", {
        name: "Memory document (Markdown bruto)",
      }),
    ).toHaveValue("![diagram](diagram.png)\n\nplain text");
    expect(
      screen.getByText("A visualização bruta preserva este Markdown"),
    ).toBeVisible();
  });

  it("preserves Markdown hard breaks when the rich editor drops them", async () => {
    mocks.editor.storage.markdown.getMarkdown = () => "first line\nsecond line";

    render(
      withIntl(<MarkdownEditor
        value={"first line  \nsecond line"}
        ariaLabel="Memory document"
      />),
    );

    expect(
      await screen.findByRole("textbox", {
        name: "Memory document (Markdown bruto)",
      }),
    ).toHaveValue("first line  \nsecond line");
  });
});

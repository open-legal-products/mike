import React, { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "tiptap-markdown";
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Table2,
} from "lucide-react";

interface WorkflowPromptEditorProps {
  value: string;
  onChange?: (markdown: string) => void;
  readOnly?: boolean;
}

const TABLE_SIZE = 5;
const INACTIVE_FORMATTING = {
  heading1: false,
  heading2: false,
  heading3: false,
  bold: false,
  italic: false,
  bulletList: false,
  orderedList: false,
};

function ToolbarButton({
  title,
  active = false,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white hover:text-gray-900 ${
        active ? "bg-gray-200 text-gray-950 hover:bg-gray-200" : ""
      }`}
    >
      {children}
    </button>
  );
}

function getEditorMarkdown(
  editor: NonNullable<ReturnType<typeof useEditor>>
): string {
  return (
    editor.storage as unknown as {
      markdown: { getMarkdown: () => string };
    }
  ).markdown.getMarkdown();
}

export function WorkflowPromptEditor({
  value,
  onChange,
  readOnly = false,
}: WorkflowPromptEditorProps): React.ReactElement {
  const lastEmittedRef = useRef(value);
  const suppressOnChangeRef = useRef(false);
  const rawTextareaRef = useRef<HTMLTextAreaElement>(null);
  const tablePickerRef = useRef<HTMLDivElement>(null);
  const [rawMode, setRawMode] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState(value);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tablePickerSize, setTablePickerSize] = useState<{
    rows: number;
    cols: number;
  } | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        code: false,
        blockquote: false,
        horizontalRule: false,
      }),
      TableKit.configure({ table: { renderWrapper: true } }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: value,
    editable: !readOnly,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const markdown = getEditorMarkdown(editor);
      lastEmittedRef.current = markdown;
      setRawMarkdown(markdown);
      if (!suppressOnChangeRef.current) onChange?.(markdown);
    },
    editorProps: {
      attributes: { class: "tiptap workflow-editor-content" },
    },
  });

  const activeFormatting =
    useEditorState({
      editor,
      selector: ({ editor }) => ({
        heading1: editor?.isActive("heading", { level: 1 }) ?? false,
        heading2: editor?.isActive("heading", { level: 2 }) ?? false,
        heading3: editor?.isActive("heading", { level: 3 }) ?? false,
        bold: editor?.isActive("bold") ?? false,
        italic: editor?.isActive("italic") ?? false,
        bulletList: editor?.isActive("bulletList") ?? false,
        orderedList: editor?.isActive("orderedList") ?? false,
      }),
    }) ?? INACTIVE_FORMATTING;

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    setRawMarkdown(value);
    suppressOnChangeRef.current = true;
    try {
      editor.commands.setContent(value);
    } finally {
      suppressOnChangeRef.current = false;
    }
  }, [editor, value]);

  useEffect(() => {
    if (!tablePickerOpen) return;
    const closeOnOutsidePointer = (event: MouseEvent): void => {
      if (!tablePickerRef.current?.contains(event.target as Node)) {
        setTablePickerOpen(false);
        setTablePickerSize(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setTablePickerOpen(false);
        setTablePickerSize(null);
      }
    };
    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [tablePickerOpen]);

  const emitRaw = (
    next: string,
    selectionStart?: number,
    selectionEnd?: number
  ): void => {
    setRawMarkdown(next);
    lastEmittedRef.current = next;
    onChange?.(next);
    if (selectionStart !== undefined) {
      requestAnimationFrame(() => {
        rawTextareaRef.current?.focus();
        rawTextareaRef.current?.setSelectionRange(
          selectionStart,
          selectionEnd ?? selectionStart
        );
      });
    }
  };

  const transformRawSelection = (
    transform: (
      selected: string,
      start: number,
      end: number
    ) => { replacement: string; selectionStart: number; selectionEnd: number }
  ): void => {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const { selectionStart: start, selectionEnd: end } = textarea;
    const result = transform(rawMarkdown.slice(start, end), start, end);
    emitRaw(
      rawMarkdown.slice(0, start) +
        result.replacement +
        rawMarkdown.slice(end),
      result.selectionStart,
      result.selectionEnd
    );
  };

  const applyRawInline = (marker: "*" | "**"): void => {
    transformRawSelection((selected, start) => ({
      replacement: `${marker}${selected}${marker}`,
      selectionStart: start + marker.length,
      selectionEnd: start + marker.length + selected.length,
    }));
  };

  const transformRawLines = (
    transformLine: (line: string, index: number) => string
  ): void => {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const lineStart = rawMarkdown.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const foundLineEnd = rawMarkdown.indexOf("\n", end);
    const lineEnd = foundLineEnd === -1 ? rawMarkdown.length : foundLineEnd;
    let lineIndex = 0;
    const replacement = rawMarkdown
      .slice(lineStart, lineEnd)
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const next = transformLine(line, lineIndex);
        lineIndex += 1;
        return next;
      })
      .join("\n");
    emitRaw(
      rawMarkdown.slice(0, lineStart) + replacement + rawMarkdown.slice(lineEnd),
      lineStart,
      lineStart + replacement.length
    );
  };

  const applyRawHeading = (level: 1 | 2 | 3): void => {
    const prefix = `${"#".repeat(level)} `;
    transformRawLines((line) => prefix + line.replace(/^#{1,6}\s+/, ""));
  };

  const applyRawList = (ordered: boolean): void => {
    transformRawLines((line, index) =>
      line
        .replace(/^(\s*)(?:[-*+]|\d+\.)\s+/, "$1")
        .replace(/^(\s*)/, ordered ? `$1${index + 1}. ` : "$1- ")
    );
  };

  const insertRawTable = (rows: number, cols: number): void => {
    const textarea = rawTextareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const before = rawMarkdown.slice(0, start);
    const after = rawMarkdown.slice(textarea.selectionEnd);
    const header = `| ${Array.from(
      { length: cols },
      (_, index) => `Column ${index + 1}`
    ).join(" | ")} |`;
    const separator = `| ${Array.from({ length: cols }, () => "---").join(
      " | "
    )} |`;
    const body = Array.from(
      { length: Math.max(0, rows - 1) },
      () => `| ${Array.from({ length: cols }, () => " ").join(" | ")} |`
    );
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const trail = after && !after.startsWith("\n") ? "\n" : "";
    const insertion = `${lead}${[header, separator, ...body].join("\n")}\n${trail}`;
    emitRaw(before + insertion + after, before.length + insertion.length);
  };

  const insertTable = (rows: number, cols: number): void => {
    setTablePickerOpen(false);
    setTablePickerSize(null);
    if (rawMode) {
      insertRawTable(rows, cols);
      return;
    }
    editor
      ?.chain()
      .focus()
      .insertTable({ rows, cols, withHeaderRow: true })
      .run();
  };

  const toggleRawMode = (): void => {
    if (!editor || editor.isDestroyed) return;
    if (rawMode) {
      lastEmittedRef.current = rawMarkdown;
      editor.commands.setContent(rawMarkdown);
      onChange?.(rawMarkdown);
      setRawMode(false);
      return;
    }
    setRawMarkdown(getEditorMarkdown(editor));
    setRawMode(true);
  };

  return (
    <div className="flex h-full min-h-[240px] flex-col overflow-hidden rounded-xl border border-white/70 bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_24px_rgba(15,23,42,0.06)]">
      <div className="flex min-h-10 shrink-0 items-center gap-0.5 border-b border-white/70 bg-white/45 px-2 py-1.5">
        {readOnly ? (
          <span className="mr-auto px-2 text-xs font-medium text-gray-500">
            Read-only
          </span>
        ) : (
          <>
            {([1, 2, 3] as const).map((level) => {
              const Icon = level === 1 ? Heading1 : level === 2 ? Heading2 : Heading3;
              return (
                <ToolbarButton
                  key={level}
                  title={`Heading ${level}`}
                  active={!rawMode && activeFormatting[`heading${level}`]}
                  onClick={() =>
                    rawMode
                      ? applyRawHeading(level)
                      : editor?.chain().focus().toggleHeading({ level }).run()
                  }
                >
                  <Icon className="h-4 w-4" />
                </ToolbarButton>
              );
            })}
            <span className="mx-1 h-4 w-px shrink-0 bg-gray-200" />
            <ToolbarButton
              title="Bold"
              active={!rawMode && activeFormatting.bold}
              onClick={() =>
                rawMode
                  ? applyRawInline("**")
                  : editor?.chain().focus().toggleBold().run()
              }
            >
              <Bold className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton
              title="Italic"
              active={!rawMode && activeFormatting.italic}
              onClick={() =>
                rawMode
                  ? applyRawInline("*")
                  : editor?.chain().focus().toggleItalic().run()
              }
            >
              <Italic className="h-4 w-4" />
            </ToolbarButton>
            <span className="mx-1 h-4 w-px shrink-0 bg-gray-200" />
            <ToolbarButton
              title="Bullet list"
              active={!rawMode && activeFormatting.bulletList}
              onClick={() =>
                rawMode
                  ? applyRawList(false)
                  : editor?.chain().focus().toggleBulletList().run()
              }
            >
              <List className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton
              title="Numbered list"
              active={!rawMode && activeFormatting.orderedList}
              onClick={() =>
                rawMode
                  ? applyRawList(true)
                  : editor?.chain().focus().toggleOrderedList().run()
              }
            >
              <ListOrdered className="h-4 w-4" />
            </ToolbarButton>
            <div ref={tablePickerRef} className="relative">
              <ToolbarButton
                title="Insert table"
                active={tablePickerOpen}
                onClick={() => setTablePickerOpen((open) => !open)}
              >
                <Table2 className="h-4 w-4" />
              </ToolbarButton>
              {tablePickerOpen && (
                <div
                  role="dialog"
                  aria-label="Insert table"
                  className="absolute left-0 top-full z-[250] mt-1 rounded-md border border-gray-200 bg-white p-2 shadow-lg"
                >
                  <div
                    className="grid gap-1"
                    style={{ gridTemplateColumns: `repeat(${TABLE_SIZE}, 1rem)` }}
                  >
                    {Array.from({ length: TABLE_SIZE * TABLE_SIZE }, (_, index) => {
                      const rows = Math.floor(index / TABLE_SIZE) + 1;
                      const cols = (index % TABLE_SIZE) + 1;
                      const selected =
                        !!tablePickerSize &&
                        rows <= tablePickerSize.rows &&
                        cols <= tablePickerSize.cols;
                      return (
                        <button
                          key={`${rows}-${cols}`}
                          type="button"
                          aria-label={`Insert ${rows} by ${cols} table`}
                          onMouseEnter={() => setTablePickerSize({ rows, cols })}
                          onFocus={() => setTablePickerSize({ rows, cols })}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            insertTable(rows, cols);
                          }}
                          className={`h-4 w-4 rounded-[3px] border ${
                            selected
                              ? "border-gray-700 bg-gray-800"
                              : "border-gray-200 bg-white"
                          }`}
                        />
                      );
                    })}
                  </div>
                  <p className="mt-2 text-center text-[10px] text-gray-500">
                    {tablePickerSize
                      ? `${tablePickerSize.rows} x ${tablePickerSize.cols}`
                      : "Select size"}
                  </p>
                </div>
              )}
            </div>
          </>
        )}
        <span className="ml-auto" />
        <ToolbarButton
          title={rawMode ? "Show rich editor" : "Show raw Markdown"}
          active={rawMode}
          onClick={toggleRawMode}
        >
          <Code2 className="h-4 w-4" />
        </ToolbarButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rawMode ? (
          <textarea
            ref={rawTextareaRef}
            value={rawMarkdown}
            onChange={(event) => emitRaw(event.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            aria-label="Raw Markdown"
            className="h-full min-h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-xs leading-6 text-gray-800 outline-none read-only:cursor-default"
          />
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>
    </div>
  );
}

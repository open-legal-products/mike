/**
 * The tools that WRITE to stored content rather than read it: they create
 * `documents` rows (and, in a project chat, attach them to the project) or
 * they rewrite an existing document's bytes and versions.
 *
 * Naming them is what lets a surface hand the model a read-only tool set. A
 * chat and the documents it can reach are two different resources with two
 * different owners: standing on the thread (holding a direct grant) says
 * nothing about standing in the project whose documents these tools would
 * rewrite. See `allowDocumentMutation` in ../streaming.ts.
 *
 * Everything else in the base set — read_document, find_in_document,
 * list_documents, fetch_documents, ask_inputs, the workflow and research
 * tools — only reads, so a collaborator who may talk in the thread keeps the
 * whole conversational surface.
 */
export const DOCUMENT_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "edit_document",
  "replicate_document",
  "generate_docx",
  "generate_excel",
  "generate_ppt",
]);

/** Read a tool schema's function name, whatever shape the entry arrived in. */
function toolName(tool: unknown): string | null {
  const fn = (tool as { function?: { name?: unknown } } | null)?.function;
  return typeof fn?.name === "string" ? fn.name : null;
}

export function isDocumentMutatingTool(name: string | null | undefined): boolean {
  return !!name && DOCUMENT_MUTATING_TOOL_NAMES.has(name);
}

/**
 * Drop every content-writing tool from a tool list. Applied to the whole
 * advertised set (base, project extras, MCP and client tools alike) so a
 * read-only caller cannot be handed a writer through some other list.
 */
export function withoutDocumentMutatingTools<T>(tools: T[]): T[] {
  return tools.filter((tool) => !isDocumentMutatingTool(toolName(tool)));
}

export const PROJECT_EXTRA_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_documents",
      description:
        "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_documents",
      description:
        "Read the full text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once. In one response, fetch each document/version at most once; after it has been fetched, use the prior tool result or find_in_document for targeted checks.",
      parameters: {
        type: "object",
        properties: {
          doc_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
          },
        },
        required: ["doc_ids"],
      },
    },
  },
];

export const TABULAR_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_table_cells",
      description:
        "Read the extracted cell content from the tabular review. Each cell contains the value extracted for a specific column from a specific document. Pass col_indices and/or row_indices (0-based) to read a subset; omit either to read all columns or all rows.",
      parameters: {
        type: "object",
        properties: {
          col_indices: {
            type: "array",
            items: { type: "integer" },
            description:
              "0-based column indices to read (e.g. [0, 2]). Omit to read all columns.",
          },
          row_indices: {
            type: "array",
            items: { type: "integer" },
            description:
              "0-based document (row) indices to read (e.g. [0, 1]). Omit to read all rows.",
          },
        },
      },
    },
  },
];

export const WORKFLOW_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_workflows",
      description:
        "List all workflows available to the user. Returns each workflow's ID and title. Call this when the user asks to run a workflow, apply a template, or you need to discover what workflows exist.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_workflow",
      description:
        "Read the full instructions (prompt) of a workflow by its ID. Call this after list_workflows to load a specific workflow's prompt, then follow those instructions.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: {
            type: "string",
            description: "The workflow ID to read",
          },
        },
        required: ["workflow_id"],
      },
    },
  },
];

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "replicate_document",
      description:
        "Copy an available document, Library Template, or workflow asset without changing the source. In a project chat, copies are saved to Project Documents; otherwise they are saved to Library Files. Always use this before editing or drafting from a Library Template or workflow asset. For an ordinary document, use it only when the user specifically asks for a copy/duplicate or a new document based on that file. Returns new doc_id slugs for read_document and edit_document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description:
              "Chat-local ID of the source document, Library Template, or workflow asset.",
          },
          count: {
            type: "integer",
            description:
              "How many copies to create. Defaults to 1. Maximum 20.",
            minimum: 1,
            maximum: 20,
          },
          new_filename: {
            type: "string",
            description:
              "New base filename. Required for Library Templates and workflow assets. With count > 1, copies are numbered. The extension is forced to match the source.",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_inputs",
      description:
        "Ask the user for one or more decisions, open-ended answers, clarifications, or document uploads before continuing. Use choice when exactly one option should be selected, multi_choice when one or more options may be selected, and text when the user should type a free-form answer and there are no useful suggested options. Use this when guessing would materially affect the answer or when required documents have not been attached. Put all needed questions and document requests in one items array. After calling ask_inputs, do not continue the substantive task until the user responds in a later message. If that response marks an input as skipped, do not ask for that input again; when drafting or editing a document, insert a descriptive placeholder in square brackets wherever the skipped value is required.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description:
              "The list of user inputs needed before continuing. Use choice for exactly one selection, multi_choice for one or more selections, text for open-ended answers such as a name or address, and documents for required uploads.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable short ID for this input, unique within this tool call.",
                },
                kind: {
                  type: "string",
                  enum: ["choice", "multi_choice", "text", "documents"],
                },
                question: {
                  type: "string",
                  description:
                    "For choice, multi_choice, and text items: the concise question to show to the user.",
                },
                options: {
                  type: "array",
                  description:
                    "For choice and multi_choice items: selectable options to show. Each option has a single user-facing value, which is also sent back if selected.",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      value: {
                        type: "string",
                        description: "The user-facing choice text.",
                      },
                    },
                    required: ["value"],
                  },
                },
                allow_other: {
                  type: "boolean",
                  description:
                    "For choice and multi_choice items: whether to show an Other option with a text field. Defaults to true.",
                },
                other_label: {
                  type: "string",
                  description:
                    "For choice and multi_choice items: label for the free-text option. Defaults to Other.",
                },
                document_types: {
                  type: "array",
                  description:
                    "For documents items only: readable labels for the types of documents you need the user to attach.",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "string",
                  },
                },
                response_prefix: {
                  type: "string",
                  description:
                    "Optional prefix the UI should include when sending this response back as the next message.",
                },
              },
              required: ["id", "kind"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description:
        "Read the full text content of an available document. Always call this before answering questions about, summarising, citing from, or editing a document, but call it at most once per document/version in a single response. After this returns, use the prior tool result or find_in_document for targeted checks instead of reading the same document/version again.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description:
              "The document ID to read (e.g. 'doc-0', 'doc-1', or 'active-word-document')",
          },
        },
        required: ["doc_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_in_document",
      description:
        "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, or a specific phrase) rather than reading the whole document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The document ID to search (e.g. 'doc-0').",
          },
          query: {
            type: "string",
            description:
              "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'.",
          },
          max_results: {
            type: "integer",
            description:
              "Maximum number of matches to return (default 20). Use a smaller value for common terms.",
          },
          context_chars: {
            type: "integer",
            description:
              "Characters of surrounding context to include on each side of a match (default 80).",
          },
        },
        required: ["doc_id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_docx",
      description:
        "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a legal document. Returns a download URL for the generated file.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Document title (used as filename and heading)",
          },
          landscape: {
            type: "boolean",
            description:
              "Set to true for landscape page orientation. Default is portrait.",
          },
          numberSections: {
            type: "boolean",
            description:
              "Apply legal numbering to section headings. Default is false. Set true only when the user explicitly requests numbered sections/clauses or a workflow, playbook, or source template requires them. Never use it for demand letters, ordinary letters, notices, memos, or reports unless numbering was requested.",
          },
          sections: {
            type: "array",
            description:
              "List of document sections. Each section may contain a heading, prose content, or a table.",
            items: {
              type: "object",
              properties: {
                heading: {
                  type: "string",
                  description: "Optional section heading",
                },
                level: {
                  type: "integer",
                  description: "Heading level: 1, 2, or 3",
                },
                content: {
                  type: "string",
                  description:
                    "Prose text content (paragraphs separated by double newlines)",
                },
                pageBreak: {
                  type: "boolean",
                  description:
                    "Set to true to start this section on a new page. Use for contract signature pages.",
                },
                table: {
                  type: "object",
                  description: "Optional table to render in this section",
                  properties: {
                    headers: {
                      type: "array",
                      items: { type: "string" },
                      description: "Column header labels",
                    },
                    rows: {
                      type: "array",
                      items: {
                        type: "array",
                        items: { type: "string" },
                      },
                      description:
                        "Array of rows, each row is an array of cell strings matching the headers order",
                    },
                  },
                  required: ["headers", "rows"],
                },
              },
            },
          },
        },
        required: ["title", "sections"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_excel",
      description:
        "Generate an Excel (.xlsx) workbook from structured sheet data. Use this when the user asks for a spreadsheet, tracker, matrix, checklist, schedule, or Excel file. Returns a download URL for the generated file.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Workbook title, used as the filename.",
          },
          sheets: {
            type: "array",
            description:
              "Workbook sheets. Each sheet has a name, columns, and rows. Row values should follow the columns order.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Sheet tab name. Keep it short.",
                },
                columns: {
                  type: "array",
                  items: { type: "string" },
                  description: "Column header labels.",
                },
                rows: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: "string" },
                  },
                  description:
                    "Array of rows, each row an array of cell strings matching the columns order.",
                },
              },
              required: ["name", "columns", "rows"],
            },
          },
        },
        required: ["title", "sheets"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_ppt",
      description:
        "Generate a PowerPoint (.pptx) presentation from structured slides. Use this when the user asks for slides, a deck, presentation, or PowerPoint file. Returns a download URL for the generated file.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Presentation title, used as the filename.",
          },
          slides: {
            type: "array",
            description:
              "Slides in order. Each slide may have a title, bullets, and optional speaker notes.",
            items: {
              type: "object",
              properties: {
                title: {
                  type: "string",
                  description: "Slide title.",
                },
                bullets: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Main bullet points for the slide. Keep each bullet concise.",
                },
                notes: {
                  type: "string",
                  description:
                    "Optional speaker notes. Included as text on a notes slide placeholder is not supported; use only for generation context.",
                },
              },
              required: ["title", "bullets"],
            },
          },
        },
        required: ["title", "slides"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_document",
      description:
        "Propose edits to a user-attached .docx as tracked changes. Each edit is a precise, minimal substitution of specific words/characters, NOT a whole-line or paragraph replacement. Use read_document first unless this same document/version has already been read in the current response. Anchor each edit with short before/after context so it can be located unambiguously. Returns per-edit annotations the UI will render as Accept/Reject cards and a download link to the edited document.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "Document slug (e.g. 'doc-0').",
          },
          edits: {
            type: "array",
            description: "List of precise substitutions.",
            items: {
              type: "object",
              properties: {
                find: {
                  type: "string",
                  description:
                    "Exact substring to replace (keep it as short as possible — ideally just the words/chars being changed).",
                },
                replace: {
                  type: "string",
                  description:
                    "Replacement text. Empty string = pure deletion.",
                },
                context_before: {
                  type: "string",
                  description:
                    "~40 chars immediately preceding `find`, used to disambiguate.",
                },
                context_after: {
                  type: "string",
                  description: "~40 chars immediately following `find`.",
                },
                reason: {
                  type: "string",
                  description:
                    "Short explanation shown to the user on the card.",
                },
              },
              required: ["find", "replace", "context_before", "context_after"],
            },
          },
        },
        required: ["doc_id", "edits"],
      },
    },
  },
];

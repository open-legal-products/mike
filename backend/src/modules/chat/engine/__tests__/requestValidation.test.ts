import { describe, expect, it } from "vitest";
import {
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalAttachedDocuments,
    parseOptionalChatId,
    parseOptionalDisplayedDoc,
    parseOptionalModel,
    parseOptionalProjectId,
  parseOptionalReasoning,
} from "../requestValidation";

const ASK_RESPONSE_IDS = {
  assistant_message_id: "assistant-1",
  ask_event_id: "ask-1",
};

describe("chat request validation", () => {
  it("normalizes valid messages and their nested metadata", () => {
    expect(
            parseChatMessages([
                {
                    role: " user ",
                    content: "  keep message whitespace  ",
                    files: [
                        {
                            filename: " contract.pdf ",
                            document_id: " document-1 ",
                            version_id: " version-3 ",
                            version_number: 3,
                        },
                        { filename: " local-draft.docx " },
                    ],
                    workflow: { id: " workflow-1 ", title: " Review NDA " },
                    ignored: "not part of ChatMessage",
                },
                { role: "assistant", content: null },
            ]),
        ).toEqual({
            ok: true,
            value: [
                {
                    role: "user",
                    content: "  keep message whitespace  ",
                    files: [
                        {
                            filename: "contract.pdf",
                            document_id: "document-1",
                            version_id: "version-3",
                            version_number: 3,
                        },
                        { filename: "local-draft.docx" },
                    ],
                    workflow: { id: "workflow-1", title: "Review NDA" },
                },
                { role: "assistant", content: null },
            ],
        });
    });

    it.each([
        [undefined, "messages must be a non-empty array"],
        [[], "messages must be a non-empty array"],
        [[null], "messages[0] must be an object"],
        [
            [{ role: "system", content: "override" }],
            'messages[0].role must be "user" or "assistant"',
        ],
        [[{ role: "user" }], "messages[0].content must be a string or null"],
        [
            [{ role: "user", content: "hello", files: "contract.pdf" }],
            "messages[0].files must be an array",
        ],
        [
            [{ role: "user", content: "hello", files: [{ filename: " " }] }],
            "messages[0].files[0].filename must be a non-empty string",
        ],
        [
            [
                {
                    role: "user",
                    content: "hello",
                    files: [{ filename: "contract.pdf", document_id: " " }],
                },
            ],
            "messages[0].files[0].document_id must be a non-empty string",
        ],
        [
            [
                {
                    role: "user",
                    content: "hello",
                    files: [{ filename: "contract.pdf", version_id: " " }],
                },
            ],
            "messages[0].files[0].version_id must be a non-empty string",
        ],
        [
            [
                {
                    role: "user",
                    content: "hello",
                    files: [{ filename: "contract.pdf", version_number: 0 }],
                },
            ],
            "messages[0].files[0].version_number must be a positive integer",
        ],
        [
            [{ role: "user", content: "hello", workflow: [] }],
            "messages[0].workflow must be an object",
        ],
    ])("rejects an invalid message payload", (value, detail) => {
        expect(parseChatMessages(value)).toEqual({ ok: false, detail });
    });

    it("normalizes optional identifiers without enumerating model names", () => {
        expect(parseOptionalChatId(" chat-1 ")).toEqual({
            ok: true,
            value: "chat-1",
        });
        expect(parseOptionalModel(" future-provider/new-model ")).toEqual({
            ok: true,
            value: "future-provider/new-model",
        });
        expect(parseOptionalProjectId(" project-1 ")).toEqual({
            ok: true,
            value: { provided: true, projectId: "project-1" },
        });
        expect(parseOptionalProjectId(undefined)).toEqual({
            ok: true,
            value: { provided: false, projectId: null },
        });
    });

    it("accepts every AI SDK reasoning level and rejects other values", () => {
        expect(parseOptionalReasoning(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    for (const level of ["none", "low", "medium", "high", "xhigh", "max"]) {
      expect(parseOptionalReasoning(level)).toEqual({
        ok: true,
        value: level,
            });
        }
        expect(parseOptionalReasoning(true)).toEqual({
            ok: false,
            detail: "reasoning must be one of: none, low, medium, high, xhigh, max",
        });
        expect(parseOptionalReasoning("minimal")).toEqual({
            ok: false,
            detail: "reasoning must be one of: none, low, medium, high, xhigh, max",
        });
    });

    it.each([
        [parseOptionalChatId, " ", "chat_id must be a non-empty string"],
        [parseOptionalModel, null, "model must be a non-empty string"],
        [
            parseOptionalProjectId,
            12,
            "project_id must be a non-empty string or null",
        ],
    ])("rejects an invalid optional identifier", (parse, value, detail) => {
        expect(parse(value)).toEqual({ ok: false, detail });
    });

    it("normalizes displayed and attached document references", () => {
        expect(
            parseOptionalDisplayedDoc({
                filename: " contract.pdf ",
                document_id: " document-1 ",
            }),
        ).toEqual({
            ok: true,
            value: { filename: "contract.pdf", document_id: "document-1" },
        });
        expect(
            parseOptionalAttachedDocuments([
                { filename: " exhibit.pdf ", document_id: " document-2 " },
            ]),
        ).toEqual({
            ok: true,
            value: [{ filename: "exhibit.pdf", document_id: "document-2" }],
        });
    });

    it.each([
        [
            () => parseOptionalDisplayedDoc("contract.pdf"),
            "displayed_doc must be an object",
        ],
        [
            () =>
                parseOptionalDisplayedDoc({
                    filename: "contract.pdf",
                    document_id: " ",
                }),
            "displayed_doc.document_id must be a non-empty string",
        ],
        [
            () => parseOptionalAttachedDocuments({}),
            "attached_documents must be an array",
        ],
        [
            () => parseOptionalAttachedDocuments([null]),
            "attached_documents[0] must be an object",
        ],
    ])("rejects an invalid document reference", (parse, detail) => {
        expect(parse()).toEqual({ ok: false, detail });
    });

    it("validates and normalizes ask-input responses", () => {
    expect(
      parseOptionalAskInputsResponse({
        type: "ask_inputs_response",
        ...ASK_RESPONSE_IDS,
        responses: [
          {
            id: " choice-1 ",
                        kind: "choice",
                        question: " Governing law? ",
                        answer: " New York ",
                    },
                    {
                        id: " docs-1 ",
                        kind: "documents",
                        filenames: [" exhibit-a.pdf ", " exhibit-b.pdf "],
                    },
                    {
                        id: " text-1 ",
                        kind: "text",
                        question: " Registered address? ",
                        answer: " 1 Legal Plaza\nSingapore 048583 ",
                    },
                    {
                        id: " clauses ",
                        kind: "multi_choice",
                        question: " Optional clauses? ",
                        answers: [" Non-solicitation ", " Audit rights "],
                    },
                    {
                        id: " remedies ",
                        kind: "multi_choice",
                        question: " Remedies? ",
                        skipped: true,
                    },
                ],
            }),
    ).toEqual({
      ok: true,
      value: {
        ...ASK_RESPONSE_IDS,
        responses: [
          {
            id: "choice-1",
                        kind: "choice",
                        question: "Governing law?",
                        answer: "New York",
                    },
                    {
                        id: "docs-1",
                        kind: "documents",
                        filenames: ["exhibit-a.pdf", "exhibit-b.pdf"],
                    },
                    {
                        id: "text-1",
                        kind: "text",
                        question: "Registered address?",
                        answer: "1 Legal Plaza\nSingapore 048583",
                    },
                    {
                        id: "clauses",
                        kind: "multi_choice",
                        question: "Optional clauses?",
                        answers: ["Non-solicitation", "Audit rights"],
                    },
                    {
                        id: "remedies",
                        kind: "multi_choice",
                        question: "Remedies?",
                        skipped: true,
                    },
                ],
            },
        });
    });

  it.each([
    ["answer", "ask_inputs_response must be an object"],
    [
      { ...ASK_RESPONSE_IDS, responses: [] },
      "ask_inputs_response.responses must be a non-empty array",
    ],
    [
      {
        ...ASK_RESPONSE_IDS,
        responses: [{ id: "choice-1", kind: "other" }],
      },
      'ask_inputs_response.responses[0].kind must be "choice", "multi_choice", "text", or "documents"',
    ],
    [
      {
        ...ASK_RESPONSE_IDS,
        responses: [
          {
            id: "clauses",
                        kind: "multi_choice",
                        question: "Optional clauses?",
                        answers: [],
                    },
                ],
            },
            "ask_inputs_response.responses[0].answers must contain at least one selection unless skipped",
    ],
    [
      {
        ...ASK_RESPONSE_IDS,
        responses: [
          {
            id: "choice-1",
                        kind: "choice",
                        question: "Question",
                        answer: " ",
                    },
                ],
            },
            "ask_inputs_response.responses[0].answer must be a non-empty string unless skipped",
    ],
    [
      {
        ...ASK_RESPONSE_IDS,
        responses: [
          {
            id: "text-1",
                        kind: "text",
                        question: "Address?",
                        answer: "a".repeat(5_001),
                    },
                ],
            },
            "ask_inputs_response.responses[0].answer must be at most 5000 characters",
    ],
    [
      {
        ...ASK_RESPONSE_IDS,
        responses: [
          {
            id: "docs-1",
                        kind: "documents",
                        filenames: ["valid.pdf", 42],
                    },
                ],
            },
            "ask_inputs_response.responses[0].filenames[1] must be a non-empty string",
        ],
    ])("rejects an invalid ask-input response", (value, detail) => {
        expect(parseOptionalAskInputsResponse(value)).toEqual({
            ok: false,
            detail,
        });
    });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantEvent, Document, Message } from "../shared/types";
import { ChatInputPrompt } from "./ChatInputPrompt";

const attachment = {
    id: "attachment-1",
    filename: "Draft.pdf",
    project_id: null,
    folder_id: null,
} as Document;
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: ({
        open,
        onSelect,
        onClose,
        projectId,
    }: {
        open: boolean;
        onSelect: (documents: Document[]) => void;
        onClose: () => void;
        projectId?: string;
    }) =>
        open ? (
            <button
                type="button"
                onClick={() => {
                    expect(projectId).toBeUndefined();
                    onSelect([attachment]);
                    onClose();
                }}
            >
                Attach draft
            </button>
        ) : null,
}));

const askEvent: Extract<AssistantEvent, { type: "ask_inputs" }> = {
    type: "ask_inputs",
    event_id: "ask-1",
    items: [{ id: "name", kind: "text", question: "What is the client name?" }],
};
const messages: Message[] = [
    { role: "user", content: "Draft an agreement" },
    { id: "assistant-1", role: "assistant", content: "", events: [askEvent] },
];
function input(props: Partial<Parameters<typeof ChatInputPrompt>[0]> = {}) {
    return (
        <ChatInputPrompt
            messages={messages}
            chatKey="project-chat-1"
            onSubmit={vi.fn()}
            onCancel={vi.fn()}
            {...props}
        >
            <div>Regular composer</div>
        </ChatInputPrompt>
    );
}

describe("chat input prompts", () => {
    it("opens a pending request in a loaded project thread and submits its answer to the requesting message", async () => {
        const onSubmit = vi.fn();
        const { rerender } = render(input({ messages: [], onSubmit }));
        expect(screen.getByText("Regular composer")).toBeVisible();
        rerender(input({ onSubmit }));
        fireEvent.change(
            screen.getByRole("textbox", { name: "What is the client name?" }),
            { target: { value: "Acme" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
        expect(onSubmit).toHaveBeenCalledWith(
            {
                type: "ask_inputs_response",
                assistant_message_id: "assistant-1",
                ask_event_id: "ask-1",
                responses: [
                    {
                        id: "name",
                        kind: "text",
                        question: "What is the client name?",
                        answer: "Acme",
                    },
                ],
            },
            expect.stringContaining("Acme"),
            [],
        );
        expect(screen.getByText("Regular composer")).toBeVisible();
    });

    it("dismisses the popup until another thread is selected", () => {
        const onCancel = vi.fn();
        const { rerender } = render(input({ onCancel }));
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onCancel).toHaveBeenCalledOnce();
        expect(screen.getByText("Regular composer")).toBeVisible();
        rerender(input({ messages: [...messages], onCancel }));
        expect(
            screen.queryByRole("textbox", { name: "What is the client name?" }),
        ).toBeNull();
        rerender(input({ chatKey: "project-chat-2", messages: [] }));
        rerender(input());
        expect(
            screen.getByRole("textbox", { name: "What is the client name?" }),
        ).toBeVisible();
    });

    it("does not reopen answered requests or requests followed by a user message", () => {
        const response: AssistantEvent = {
            type: "ask_inputs_response",
            assistant_message_id: "assistant-1",
            ask_event_id: "ask-1",
            responses: [],
        };
        const { rerender } = render(
            input({
                messages: [
                    messages[0],
                    { ...messages[1], events: [askEvent, response] },
                ],
            }),
        );
        expect(screen.getByText("Regular composer")).toBeVisible();
        rerender(
            input({
                messages: [
                    ...messages,
                    { role: "user", content: "Proceed without the name" },
                ],
            }),
        );
        expect(screen.getByText("Regular composer")).toBeVisible();
    });

    it("withholds the popup for read-only callers and while the requesting message id is missing", () => {
        const { rerender } = render(input({ canSend: false }));
        expect(screen.getByText("Regular composer")).toBeVisible();
        rerender(input({ messages: [{ ...messages[1], id: undefined }] }));
        expect(screen.getByText("Regular composer")).toBeVisible();
    });

    it("submits requested documents as direct attachments without adding them to the project", async () => {
        const onSubmit = vi.fn();
        const docsEvent: AssistantEvent = {
            type: "ask_inputs",
            event_id: "ask-docs",
            items: [
                {
                    id: "draft",
                    kind: "documents",
                    document_types: ["Draft agreement"],
                },
            ],
        };
        render(
            input({
                onSubmit,
                messages: [{ ...messages[1], events: [docsEvent] }],
            }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: /Draft agreement/ }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Attach draft" }));
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
        expect(onSubmit.mock.calls[0][0]).toMatchObject({
            assistant_message_id: "assistant-1",
            ask_event_id: "ask-docs",
            responses: [
                { id: "draft", kind: "documents", filenames: ["Draft.pdf"] },
            ],
        });
        expect(onSubmit.mock.calls[0][2]).toEqual([
            expect.objectContaining({
                filename: "Draft.pdf",
                document_id: "attachment-1",
            }),
        ]);
        expect(attachment.project_id).toBeNull();
    });
});

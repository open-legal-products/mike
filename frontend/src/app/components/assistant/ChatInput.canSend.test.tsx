import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    uploadProjectDocuments,
    uploadStandaloneDocuments,
} from "@/app/lib/mikeApi";
import type { Document } from "@/app/components/shared/types";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    uploadStandaloneDocument: vi.fn(),
    uploadProjectDocuments: vi.fn(),
    uploadStandaloneDocuments: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: vi.fn(),
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));

vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));

vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./ModelToggle")>()),
    ModelToggle: () => null,
}));

vi.mock("./AddDocButton", () => ({
    AddDocButton: () => <button aria-label="Add documents" />,
}));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: vi.fn(() => null),
}));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

function mockProfile() {
    vi.mocked(useUserProfile).mockReturnValue({
        profile: {
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
            apiKeys: {},
        },
        loading: false,
        apiKeysDegraded: false,
    } as unknown as ReturnType<typeof useUserProfile>);
}

function renderInput(canSend: boolean | null, onSubmit = vi.fn()) {
    render(
        <ChatInput
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            isLoading={false}
            canSend={canSend}
            projectId="p1"
        />,
    );
    return onSubmit;
}

describe("ChatInput canSend gating", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        mockProfile();
    });

    it.each(["", "  \n\t", "Replace this draft"])(
        "trims pasted message edges while preserving internal formatting (draft: %j)",
        async (draft) => {
            const user = userEvent.setup();
            renderInput(true);
            const input = screen.getByRole("combobox") as HTMLTextAreaElement;
            fireEvent.change(input, { target: { value: draft } });
            await user.click(input);
            input.setSelectionRange(0, draft.length);
            await user.paste(" \n\tFirst paragraph\n\n    Indented line\nLast paragraph\n  ");
            expect(input).toHaveValue("First paragraph\n\n    Indented line\nLast paragraph");
            expect(input.selectionStart).toBe(input.value.length);
            expect(input.selectionEnd).toBe(input.value.length);
        },
    );

    it("preserves pasted spacing when inserting into an existing message", async () => {
        const user = userEvent.setup();
        renderInput(true);
        const input = screen.getByRole("combobox") as HTMLTextAreaElement;
        fireEvent.change(input, { target: { value: "Reviewclause" } });
        await user.click(input);
        input.setSelectionRange(6, 6);
        await user.paste(" this ");
        expect(input).toHaveValue("Review this clause");
    });

    it("ignores whitespace-only pasted messages and leaves Send disabled", async () => {
        const user = userEvent.setup();
        renderInput(true);
        const input = screen.getByRole("combobox");
        await user.click(input);
        await user.paste(" \n\t ");
        expect(input).toHaveValue("");
        expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    });

    it("renders a read-only composer when canSend is false", () => {
        renderInput(false);

        const textarea = screen.getByPlaceholderText(
            "Viewing only — sending needs edit access",
        );
        expect(textarea).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled();
        expect(
            screen.queryByRole("button", { name: "Add documents" }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Open workflows" }),
        ).toBeNull();
    });

    it("can stop a pending response while history is still loading", () => {
        const onCancel = vi.fn();
        render(<ChatInput onSubmit={vi.fn()} onCancel={onCancel} isLoading canSend={false} />);
        const stop = screen.getByRole("button", { name: "Stop response" });
        expect(stop).toBeEnabled();
        fireEvent.click(stop);
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it("says a response is still arriving rather than blaming permissions", () => {
        // Returning to a thread whose answer is still streaming, while its
        // history is on its way, closes the composer, but the reader may
        // write here — only the history is missing. Blaming edit access would
        // be a lie (see #486).
        render(
            <ChatInput
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading
                canSend
                chatLoading
            />,
        );

        expect(
            screen.getByPlaceholderText("A response is still arriving\u2026"),
        ).toBeDisabled();
        expect(
            screen.queryByPlaceholderText(
                "Viewing only \u2014 sending needs edit access",
            ),
        ).toBeNull();
        // The turn is stoppable from here even though sending is closed.
        expect(
            screen.getByRole("button", { name: "Stop response" }),
        ).toBeEnabled();
    });

    it("says the chat is loading when no response is running", () => {
        render(
            <ChatInput
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
                canSend
                chatLoading
            />,
        );

        expect(
            screen.getByPlaceholderText("Loading this chat\u2026"),
        ).toBeDisabled();
    });

    it("keeps the permission copy when the reader may not write", () => {
        render(
            <ChatInput
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading
                canSend={false}
                chatLoading
            />,
        );

        expect(
            screen.getByPlaceholderText(
                "Viewing only \u2014 sending needs edit access",
            ),
        ).toBeDisabled();
    });

    it("does not submit on Enter while the chat is still loading", () => {
        const onSubmit = vi.fn();
        render(
            <ChatInput
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
                canSend
                chatLoading
            />,
        );

        const textarea = screen.getByRole("combobox");
        expect(textarea).toBeDisabled();
        fireEvent.change(textarea, { target: { value: "second question" } });
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not submit on Enter when canSend is false", () => {
        const onSubmit = renderInput(false);
        const textarea = screen.getByRole("combobox");

        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("ignores window file drops when canSend is false", () => {
        renderInput(false);

        const file = new File(["x"], "dropped.pdf", {
            type: "application/pdf",
        });
        const dataTransfer = {
            types: ["Files"],
            files: [file],
        } as unknown as DataTransfer;
        fireEvent.drop(window, { dataTransfer });

        expect(uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("ignores file drops while chat history is loading", () => {
        const ref = createRef<ChatInputHandle>();
        render(
            <ChatInput
                ref={ref}
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
                canSend
                chatLoading
                projectId="p1"
            />,
        );

        const file = new File(["x"], "dropped.pdf", {
            type: "application/pdf",
        });
        const dataTransfer = {
            types: ["Files"],
            files: [file],
        } as unknown as DataTransfer;
        fireEvent.drop(window, { dataTransfer });
        ref.current?.addFiles([file]);

        expect(uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("stays neutral while the caller's standing is unknown", () => {
        // null is "not known yet", not "not allowed". The composer is closed
        // the same way, but accusing an owner of viewer status for the length
        // of a fetch — which is what every cold load did — is a wrong
        // statement, not a loading state.
        renderInput(null);

        const textarea = screen.getByPlaceholderText("Loading…");
        expect(textarea).toBeDisabled();
        expect(
            screen.queryByPlaceholderText(
                "Viewing only — sending needs edit access",
            ),
        ).toBeNull();
        expect(
            screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled();
    });

    it("does not submit on Enter while the standing is unknown", () => {
        const onSubmit = renderInput(null);
        const textarea = screen.getByRole("combobox");

        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("keeps the default composer when canSend is omitted", () => {
        render(
            <ChatInput
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
                projectId="p1"
            />,
        );

        expect(
            screen.getByPlaceholderText("How can I help?"),
        ).not.toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Add documents" }),
        ).toBeInTheDocument();
    });

    it("can attach a local drop without adding it to the project", async () => {
        vi.mocked(uploadStandaloneDocuments).mockResolvedValue([]);
        const ref = createRef<ChatInputHandle>();
        render(
            <ChatInput
                ref={ref}
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
                projectId="p1"
                enableGlobalFileDrop={false}
                dropUploadsToProject={false}
            />,
        );
        const file = new File(["x"], "attachment.pdf", {
            type: "application/pdf",
        });

        fireEvent.drop(window, {
            dataTransfer: { types: ["Files"], files: [file] },
        });
        expect(uploadStandaloneDocuments).not.toHaveBeenCalled();

        ref.current?.addFiles([file]);

        await waitFor(() =>
            expect(uploadStandaloneDocuments).toHaveBeenCalledOnce(),
        );
        expect(uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("discards an upload that finishes after switching chats", async () => {
        let finishUpload!: (
            outcomes: Awaited<ReturnType<typeof uploadStandaloneDocuments>>,
        ) => void;
        vi.mocked(uploadStandaloneDocuments).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishUpload = resolve;
                }),
        );
        const ref = createRef<ChatInputHandle>();
        const view = (chatKey: string) => (
            <ChatInput
                ref={ref}
                chatKey={chatKey}
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
                enableGlobalFileDrop={false}
                dropUploadsToProject={false}
            />
        );
        const { rerender } = render(view("chat-a"));
        const file = new File(["x"], "old-chat.pdf", {
            type: "application/pdf",
        });

        ref.current?.addFiles([file]);
        await waitFor(() =>
            expect(uploadStandaloneDocuments).toHaveBeenCalledOnce(),
        );
        rerender(view("chat-b"));
        await act(async () => {
            finishUpload([
                {
                    clientId: "upload-1",
                    filename: "old-chat.pdf",
                    status: "completed",
                    result: {
                        id: "old-document",
                        filename: "old-chat.pdf",
                    } as Document,
                    errorCode: null,
                },
            ]);
        });

        expect(screen.queryByText("old-chat.pdf")).toBeNull();
        expect(
            vi.mocked(AddDocumentsModal).mock.calls.at(-1)?.[0]
                .externalUploadedDocuments,
        ).toEqual([]);
    });

    it("discards an upload failure after switching chats", async () => {
        let failUpload!: (error: Error) => void;
        vi.mocked(uploadStandaloneDocuments).mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    failUpload = reject;
                }),
        );
        const ref = createRef<ChatInputHandle>();
        const view = (chatKey: string) => (
            <ChatInput
                ref={ref}
                chatKey={chatKey}
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
                enableGlobalFileDrop={false}
                dropUploadsToProject={false}
            />
        );
        const { rerender } = render(view("chat-a"));

        ref.current?.addFiles(
            [new File(["x"], "old-chat.pdf", { type: "application/pdf" })],
        );
        await waitFor(() =>
            expect(uploadStandaloneDocuments).toHaveBeenCalledOnce(),
        );
        rerender(view("chat-b"));
        await act(async () => {
            failUpload(new Error("old chat upload failed"));
        });

        expect(screen.queryByText(/could not be uploaded/i)).toBeNull();
    });

    it("keeps picker attachments separate from the project just like dropped files", () => {
        render(
            <ChatInput
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
                projectId="p1"
                dropUploadsToProject={false}
            />,
        );

        const pickerProps = vi.mocked(AddDocumentsModal).mock.calls.at(-1)?.[0];
        expect(pickerProps?.projectId).toBeUndefined();
    });
});

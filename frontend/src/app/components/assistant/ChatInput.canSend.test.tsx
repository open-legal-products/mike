import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    uploadProjectDocument,
    uploadProjectDocuments,
    uploadStandaloneDocuments,
} from "@/app/lib/mikeApi";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocument: vi.fn(),
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

function renderInput(canSend: boolean, onSubmit = vi.fn()) {
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
        // Returning to a thread whose detached answer is still running closes
        // the composer, but the reader may write here — only the history is
        // missing. Blaming edit access would be a lie (see #486).
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

        expect(uploadProjectDocument).not.toHaveBeenCalled();
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

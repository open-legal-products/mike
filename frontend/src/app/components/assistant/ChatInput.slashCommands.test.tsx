import { createRef } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listWorkflows } from "@/app/lib/mikeApi";
import type { Document, Workflow } from "../shared/types";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));

vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["claude-sonnet-4-6", vi.fn()],
    useSelectedReasoning: () => ["high", vi.fn()],
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));

vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));

vi.mock("./AddDocButton", () => ({ AddDocButton: () => null }));
vi.mock("./UploadOverlay", () => ({ UploadOverlay: () => null }));
vi.mock("../shared/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));
vi.mock("./ModelToggle", () => ({ ModelToggle: () => null }));

const workflow = {
    id: "workflow-1",
    metadata: {
        name: "contract-intake",
        title: "Contract Intake",
    },
} as Workflow;

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

describe("ChatInput workflow slash commands", () => {
    beforeEach(() => {
        vi.mocked(listWorkflows).mockResolvedValue([workflow]);
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    });

    it.each(["docx", "pdf", "xlsx", "xlsm", "xls"])(
        "opens an attached %s document without removing it",
        async (extension) => {
            const ref = createRef<ChatInputHandle>();
            const onDocumentClick = vi.fn();
            const user = userEvent.setup();
            const document = {
                id: "document-1",
                filename: `agreement.${extension}`,
                file_type: extension,
            } as Document;

            render(
                <ChatInput
                    ref={ref}
                    onSubmit={vi.fn()}
                    onCancel={vi.fn()}
                    isLoading={false}
                    onDocumentClick={onDocumentClick}
                />,
            );

            act(() => ref.current?.addDoc(document));
            const openButton = screen.getByRole("button", {
                name: `Open agreement.${extension}`,
            });
            expect(openButton.parentElement).toHaveClass("liquid-glass-flat");
            expect(openButton.parentElement).not.toHaveClass(
                "liquid-glass-subtle",
            );
            await user.click(openButton);

            expect(onDocumentClick).toHaveBeenCalledWith(document);
            expect(
                screen.getByRole("button", {
                    name: `Remove agreement.${extension}`,
                }),
            ).toBeInTheDocument();
        },
    );

    it("submits the attached document's current version", async () => {
        const ref = createRef<ChatInputHandle>();
        const onSubmit = vi.fn();
        const user = userEvent.setup();
        const document = {
            id: "document-1",
            filename: "agreement.docx",
            file_type: "docx",
            current_version_id: "version-4",
            active_version_number: 4,
        } as Document;

        render(
            <ChatInput
                ref={ref}
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
            />,
        );

        act(() => ref.current?.addDoc(document));
        await user.type(screen.getByRole("combobox"), "Review this");
        await user.keyboard("{Enter}");

        expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
                files: [
                    {
                        filename: "agreement.docx",
                        document_id: "document-1",
                        version_id: "version-4",
                        version_number: 4,
                    },
                ],
            }),
        );
    });

    it("attaches the selected workflow without submitting", async () => {
        const onSubmit = vi.fn();
        const user = userEvent.setup();
        render(
            <ChatInput
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
            />,
        );

        const input = screen.getByRole("combobox");
        await user.type(input, "/cont");
        await screen.findByRole("option", {
            name: "/contract-intake Contract Intake",
        });
        await user.keyboard("{Enter}");

        expect(onSubmit).not.toHaveBeenCalled();
        expect(input).toHaveValue("");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(screen.getByText("Contract Intake")).toBeInTheDocument();

        await user.type(input, "Review this agreement");
        await user.keyboard("{Enter}");

        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({
                    role: "user",
                    content: "Review this agreement",
                    workflow: {
                        id: "workflow-1",
                        title: "Contract Intake",
                    },
                }),
            ),
        );
    });

    it("offers a command typed mid-message and keeps the rest of the draft", async () => {
        const onSubmit = vi.fn();
        const user = userEvent.setup();
        render(
            <ChatInput
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
            />,
        );

        const input = screen.getByRole("combobox");
        await user.type(input, "review this using /cont");
        await screen.findByRole("option", {
            name: "/contract-intake Contract Intake",
        });
        await user.keyboard("{Enter}");

        expect(onSubmit).not.toHaveBeenCalled();
        // The command goes; everything typed before it stays.
        expect(input).toHaveValue("review this using ");
        expect(screen.getByText("Contract Intake")).toBeInTheDocument();
    });

    it("replaces an existing draft with an explicitly supplied workflow prompt", async () => {
        const ref = createRef<ChatInputHandle>();
        const user = userEvent.setup();
        render(
            <ChatInput
                ref={ref}
                onSubmit={vi.fn()}
                onCancel={vi.fn()}
                isLoading={false}
            />,
        );

        const input = screen.getByRole("combobox");
        await user.type(input, "Existing draft");

        act(() => {
            ref.current?.startWorkflow(
                { id: "workflow-1", title: "Contract Intake" },
                "Quick Action prompt",
            );
        });

        expect(input).toHaveValue("Quick Action prompt");

        await user.clear(input);
        await user.type(input, "Another existing draft");

        act(() => {
            ref.current?.startWorkflowDocumentSelection(
                { id: "workflow-1", title: "Contract Intake" },
                "Document Quick Action prompt",
            );
        });

        expect(input).toHaveValue("Document Quick Action prompt");
    });

    it("treats slash as ordinary input when workflow titles cannot form commands", async () => {
        let resolveWorkflows!: (workflows: Workflow[]) => void;
        vi.mocked(listWorkflows).mockReturnValue(
            new Promise((resolve) => {
                resolveWorkflows = resolve;
            }),
        );
        const workflowsWithoutCommands = [
            {
                ...workflow,
                metadata: {
                    ...workflow.metadata,
                    name: null,
                    title: "---",
                },
            } as Workflow,
        ];
        const onSubmit = vi.fn();
        const user = userEvent.setup();
        render(
            <ChatInput
                onSubmit={onSubmit}
                onCancel={vi.fn()}
                isLoading={false}
            />,
        );

        const input = screen.getByRole("combobox");
        await user.type(input, "/");

        expect(input).toHaveValue("/");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();

        await act(async () => {
            resolveWorkflows(workflowsWithoutCommands);
        });

        expect(input).toHaveValue("/");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();

        await user.keyboard("{Enter}");

        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({
                    role: "user",
                    content: "/",
                    workflow: undefined,
                }),
            ),
        );
    });
});

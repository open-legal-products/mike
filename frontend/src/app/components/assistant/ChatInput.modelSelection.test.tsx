import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { withIntl } from "@/test/withIntl";
import { ChatInput } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: vi.fn(),
}));

vi.mock("@/app/lib/modelAvailability", () => ({
    getModelProvider: vi.fn(),
    isModelAvailable: vi.fn(() => true),
}));

// The real module is kept for its constants — useSelectedModel imports
// ALLOWED_MODEL_IDS/DEFAULT_MODEL_ID/canonicalModelId from it, and this test
// exercises the real hook.
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./ModelToggle")>()),
    ModelToggle: ({
        onChange,
        onReasoningChange,
    }: {
        onChange: (model: string) => void;
        onReasoningChange?: (reasoning: "xhigh") => void;
    }) => (
        <>
            <button type="button" onClick={() => onChange("gpt-5.6-sol")}>
                Select test model
            </button>
            <button type="button" onClick={() => onReasoningChange?.("xhigh")}>
                Select test reasoning
            </button>
        </>
    ),
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

const STORED = "openrouter/pricy/frontier";
const persistChatModelSelection = vi.fn(async () => true);
const persistChatReasoningSelection = vi.fn(async () => true);

class ResizeObserverMock {
    observe() {}
    disconnect() {}
}

function emptyApiKeys() {
    return {
        claude: { configured: false, source: null },
        gemini: { configured: false, source: null },
        openai: { configured: false, source: null },
        openrouter: { configured: false, source: null },
        vercel: { configured: false, source: null },
        courtlistener: { configured: false, source: null },
    };
}

function mockProfile(apiKeysDegraded: boolean) {
    vi.mocked(useUserProfile).mockReturnValue({
        profile: {
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
            lastSelectedChatModel: "gpt-5.6-luna",
            lastSelectedReasoningLevel: "high",
            apiKeys: emptyApiKeys(),
        },
        loading: false,
        apiKeysDegraded,
        persistChatModelSelection,
        persistChatReasoningSelection,
    } as unknown as ReturnType<typeof useUserProfile>);
}

describe("ChatInput model selection vs. a degraded profile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    });

    it("persists reasoning immediately for an existing chat", async () => {
        mockProfile(false);
        render(
            withIntl(
                <ChatInput
                    chatKey="chat-1"
                    chatModel="gpt-5.6-luna"
                    chatReasoningLevel="high"
                    onSubmit={vi.fn()}
                    onCancel={vi.fn()}
                    isLoading={false}
                />,
            ),
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Select test reasoning" }),
        );

        await waitFor(() =>
            expect(persistChatReasoningSelection).toHaveBeenCalledWith(
                "xhigh",
                "chat-1",
            ),
        );
    });

    it("persists an initial-view selection to the profile immediately", async () => {
        mockProfile(false);
        render(
            withIntl(
                <ChatInput
                    onSubmit={vi.fn()}
                    onCancel={vi.fn()}
                    isLoading={false}
                />,
            ),
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Select test model" }),
        );

        await waitFor(() =>
            expect(persistChatModelSelection).toHaveBeenCalledWith(
                "gpt-5.6-sol",
                undefined,
            ),
        );
    });

    it("persists an existing-chat selection to the chat and profile immediately", async () => {
        mockProfile(false);
        render(
            withIntl(
                <ChatInput
                    chatKey="chat-1"
                    chatModel="gpt-5.6-luna"
                    chatReasoningLevel="high"
                    onSubmit={vi.fn()}
                    onCancel={vi.fn()}
                    isLoading={false}
                />,
            ),
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Select test model" }),
        );

        await waitFor(() =>
            expect(persistChatModelSelection).toHaveBeenCalledWith(
                "gpt-5.6-sol",
                "chat-1",
            ),
        );
    });

    it("passes the tabular chat selection key through on toggle changes", async () => {
        mockProfile(false);
        const tabularChatKey = "tabular-review-chat:review-1:chat-1";
        render(
            withIntl(
                <ChatInput
                    chatKey={tabularChatKey}
                    chatModel="gpt-5.6-luna"
                    chatReasoningLevel="high"
                    onSubmit={vi.fn()}
                    onCancel={vi.fn()}
                    isLoading={false}
                />,
            ),
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Select test model" }),
        );

        await waitFor(() =>
            expect(persistChatModelSelection).toHaveBeenCalledWith(
                "gpt-5.6-sol",
                tabularChatKey,
            ),
        );
    });

    it("hides the model toggle until existing-chat settings load", () => {
        mockProfile(false);
        const { rerender } = render(
            withIntl(
                <ChatInput
                    chatKey="chat-1"
                    chatModel={undefined}
                    chatReasoningLevel={undefined}
                    onSubmit={vi.fn()}
                    onCancel={vi.fn()}
                    isLoading={false}
                />,
            ),
        );

        expect(
            screen.queryByRole("button", { name: "Select test model" }),
        ).not.toBeInTheDocument();

        rerender(
            withIntl(
                <ChatInput
                    chatKey="chat-1"
                    chatModel="gpt-5.6-luna"
                    chatReasoningLevel="high"
                    onSubmit={vi.fn()}
                    onCancel={vi.fn()}
                    isLoading={false}
                />,
            ),
        );

        expect(
            screen.getByRole("button", { name: "Select test model" }),
        ).toBeInTheDocument();
    });

    it("keeps the chat model when router availability is unknown", async () => {
        mockProfile(true);
        const onSubmit = vi.fn();

        render(
            withIntl(
                <ChatInput
                    chatModel={STORED}
                    onSubmit={onSubmit}
                    onCancel={vi.fn()}
                    isLoading={false}
                />,
            ),
        );

        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "hello" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));
        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({ model: STORED }),
            ),
        );
    });

    it("falls back to profile last-selected when the chat router model is stale", async () => {
        mockProfile(false);
        const onSubmit = vi.fn();

        render(
            withIntl(
                <ChatInput
                    chatModel={STORED}
                    onSubmit={onSubmit}
                    onCancel={vi.fn()}
                    isLoading={false}
                />,
            ),
        );

        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "hello" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));
        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({ model: "gpt-5.6-luna" }),
            ),
        );
    });
});

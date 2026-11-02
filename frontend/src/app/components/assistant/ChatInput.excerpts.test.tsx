import { createRef } from "react";
import {
    act,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

vi.mock("@/app/lib/mikeApi", () => ({
    listWorkflows: vi.fn(async () => []),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));
vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["claude-sonnet-4-6", vi.fn()],
    useSelectedReasoning: () => ["high", vi.fn()],
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
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

class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
}

function renderInput(canSend: boolean | null = true) {
    const onSubmit = vi.fn();
    const ref = createRef<ChatInputHandle>();
    render(
        <ChatInput
            ref={ref}
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            isLoading={false}
            canSend={canSend}
        />,
    );
    return { onSubmit, ref };
}

describe("ChatInput excerpts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    });

    it("shows an excerpt pill and quotes it above the sent message", async () => {
        const user = userEvent.setup();
        const { onSubmit, ref } = renderInput();

        act(() => ref.current?.addExcerpt({ text: "Notice is 30 days." }));
        // The pill names what it is; the passage itself is one click away.
        expect(screen.getByText("Excerpt")).toBeInTheDocument();
        expect(screen.queryByText("Notice is 30 days.")).toBeNull();
        // A bare excerpt asks nothing yet.
        expect(
            screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled();

        await user.type(screen.getByRole("combobox"), "Is that standard?");
        await user.keyboard("{Enter}");

        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: "> Notice is 30 days.\n\nIs that standard?",
                }),
            ),
        );
        expect(screen.queryByText("Excerpt")).toBeNull();
    });

    it("sends an annotated excerpt without any typed message", async () => {
        const user = userEvent.setup();
        const { onSubmit, ref } = renderInput();

        act(() =>
            ref.current?.addExcerpt({ text: "Clause 4", note: "Why?" }),
        );
        expect(screen.getByText("Annotated Excerpt")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Send message" }));

        await waitFor(() =>
            expect(onSubmit).toHaveBeenCalledWith(
                expect.objectContaining({ content: "> Clause 4\nNote: Why?" }),
            ),
        );
    });

    it("removes an excerpt and ignores a duplicate", async () => {
        const user = userEvent.setup();
        const { ref } = renderInput();

        act(() => ref.current?.addExcerpt({ text: "Clause 4" }));
        act(() => ref.current?.addExcerpt({ text: "Clause 4" }));
        expect(screen.getAllByText("Excerpt")).toHaveLength(1);

        await user.click(
            screen.getByRole("button", { name: "Remove excerpt: Clause 4" }),
        );
        expect(screen.queryByText("Excerpt")).toBeNull();
    });

    it("opens the full excerpt and its annotation from the pill", async () => {
        const user = userEvent.setup();
        const { ref } = renderInput();

        act(() =>
            ref.current?.addExcerpt({ text: "Clause 4", note: "Why?" }),
        );
        await user.click(
            screen.getByRole("button", { name: "View excerpt: Clause 4" }),
        );

        const dialog = await screen.findByRole("dialog", {
            name: "Annotated Excerpt",
        });
        expect(within(dialog).getByText("Clause 4")).toBeInTheDocument();
        expect(within(dialog).getByText("Annotation")).toBeInTheDocument();
        expect(within(dialog).getByText("Why?")).toBeInTheDocument();
    });

    it("does not take excerpts into a read-only composer", () => {
        const { ref } = renderInput(false);

        act(() => ref.current?.addExcerpt({ text: "Clause 4" }));
        expect(screen.queryByText("Excerpt")).toBeNull();
    });
});

import { createRef } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import {
    MAX_QUOTED_EXCERPT_CHARS,
    parseQuotedMessageContent,
} from "@/app/lib/quotedExcerpts";

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

// Keep the real module's constants — useSelectedModel imports
// ALLOWED_MODEL_IDS from it — but drop the widget.
vi.mock("./ModelToggle", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./ModelToggle")>()),
    ModelToggle: () => null,
}));

// There is no default model any more: an unselected composer refuses to send
// before it reaches the excerpt fold. These cases are about the excerpt
// plumbing, not model selection, so pin a resolvable selection the way the
// sibling composer suites do.
vi.mock("@/app/hooks/useSelectedModel", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/hooks/useSelectedModel")>()),
    useSelectedModel: () => ["claude-sonnet-4-6", vi.fn()],
    useSelectedReasoning: () => ["high", vi.fn()],
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
            apiKeys: undefined,
        },
        loading: false,
        apiKeysDegraded: false,
    } as unknown as ReturnType<typeof useUserProfile>);
}

function renderComposer() {
    const onSubmit = vi.fn();
    const ref = createRef<ChatInputHandle>();
    render(
        <ChatInput
            ref={ref}
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            isLoading={false}
        />,
    );
    return { onSubmit, ref };
}

const attach = (ref: React.RefObject<ChatInputHandle | null>, text: string) =>
    act(() => {
        ref.current!.addQuotedExcerpt(text);
    });

const send = async (text: string) => {
    const textarea = screen.getByRole("combobox");
    await userEvent.type(textarea, text);
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
};

describe("ChatInput quoted excerpts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        vi.stubGlobal("ResizeObserver", ResizeObserverMock);
        mockProfile();
    });

    it("shows an attached excerpt as a chip above the composer", () => {
        const { ref } = renderComposer();
        attach(ref, "  the   indemnity clause  ");
        // Normalized on the way in.
        expect(screen.getByText("the indemnity clause")).toBeInTheDocument();
        expect(screen.getByText("Quoted from response")).toBeInTheDocument();
    });

    it("stacks multiple excerpts", () => {
        const { ref } = renderComposer();
        attach(ref, "first point");
        attach(ref, "second point");
        expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("does not attach the same excerpt twice", () => {
        const { ref } = renderComposer();
        attach(ref, "same passage");
        attach(ref, "same passage");
        expect(screen.getAllByRole("listitem")).toHaveLength(1);
    });

    it("ignores a whitespace-only selection", () => {
        const { ref } = renderComposer();
        attach(ref, "   \n  ");
        expect(screen.queryByRole("listitem")).toBeNull();
    });

    it("removes a chip when its remove button is clicked", async () => {
        const { ref } = renderComposer();
        attach(ref, "first point");
        attach(ref, "second point");
        await userEvent.click(
            screen.getByRole("button", { name: "Remove quoted excerpt 1" }),
        );
        expect(screen.getAllByRole("listitem")).toHaveLength(1);
        expect(screen.getByText("second point")).toBeInTheDocument();
        expect(screen.queryByText("first point")).toBeNull();
    });

    it("caps an over-long excerpt and says so", () => {
        const { ref } = renderComposer();
        attach(ref, "word ".repeat(MAX_QUOTED_EXCERPT_CHARS));
        expect(screen.getByRole("status")).toHaveTextContent(
            "Excerpt shortened to 4,000 characters.",
        );
        expect(
            screen.getByRole("listitem").textContent?.length,
        ).toBeLessThan(MAX_QUOTED_EXCERPT_CHARS + 100);
    });

    it("sends the typed text unchanged when nothing is attached", async () => {
        const { onSubmit } = renderComposer();
        await send("plain question");
        expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ role: "user", content: "plain question" }),
        );
    });

    it("prefixes attached excerpts onto the outgoing message content", async () => {
        const { onSubmit, ref } = renderComposer();
        attach(ref, "the indemnity clause");
        attach(ref, "the arbitration clause");
        await send("how do these interact?");

        const content = onSubmit.mock.calls[0][0].content as string;
        expect(parseQuotedMessageContent(content)).toEqual({
            excerpts: ["the indemnity clause", "the arbitration clause"],
            body: "how do these interact?",
        });
        // The excerpts travel inside `content`; no new request field.
        expect(Object.keys(onSubmit.mock.calls[0][0])).not.toContain(
            "quotedExcerpts",
        );
    });

    it("clears the chips after sending", async () => {
        const { ref } = renderComposer();
        attach(ref, "an excerpt");
        await send("question");
        await waitFor(() =>
            expect(screen.queryByRole("listitem")).toBeNull(),
        );
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("keeps the chips when the send is refused for an empty draft", async () => {
        const { onSubmit, ref } = renderComposer();
        attach(ref, "an excerpt");
        const textarea = screen.getByRole("combobox");
        await userEvent.type(textarea, "{Enter}");
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByRole("listitem")).toBeInTheDocument();
    });
});

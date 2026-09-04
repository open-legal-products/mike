import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Citation, Message } from "@/app/components/shared/types";
import { MikeApiError } from "@/app/lib/mikeApi";
import { ChatView } from "./ChatView";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";

// A chat can be shared without the documents behind it. For a shared
// STANDALONE chat that is the normal case: the recipient holds no grant on
// the single-documents, so GET /single-documents/:id/versions answers 404,
// the panel document resolved to null, and openCitation returned — no tab,
// no message, nothing. Every citation pill in a shared chat was a dead
// control. The fix is not to widen access; it is to say what happened.

const { listDocumentVersions } = vi.hoisted(() => ({
    listDocumentVersions: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listDocumentVersions: (...args: unknown[]) => listDocumentVersions(...args),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        chats: [],
        renameChat: vi.fn(),
        deleteChat: vi.fn(),
        setCurrentChatId: vi.fn(),
        setNewChatMessages: vi.fn(),
    }),
}));
vi.mock("./ChatInput", () => ({ ChatInput: () => <div>Chat input</div> }));
vi.mock("./UserMessage", () => ({ UserMessage: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("./ChatAccessModal", () => ({ ChatAccessModal: () => null }));
// Keep the tab helpers (ChatView computes tab ids with them) and stub only
// the panel itself; rendering a real document viewer is DocPanel's business,
// not this file's.
vi.mock("./AssistantSidePanel", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./AssistantSidePanel")>()),
    AssistantSidePanel: ({ tabs }: { tabs: { id: string }[] }) => (
        <div data-testid="panel-tabs">{tabs.length}</div>
    ),
}));

// Stand in for the citation pill: one button that fires the callback
// ChatView wires to openCitation.
vi.mock("./AssistantMessage", () => ({
    AssistantMessage: ({
        citations,
        onCitationClick,
    }: {
        citations?: Citation[];
        onCitationClick?: (citation: Citation) => void;
    }) => (
        <button
            type="button"
            onClick={() => citations?.[0] && onCitationClick?.(citations[0])}
        >
            citation pill
        </button>
    ),
}));

class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const chat: Chat = {
    id: "chat-1",
    project_id: null,
    user_id: "someone-else",
    title: "Quarterly filing",
    created_at: new Date().toISOString(),
    is_owner: false,
    access_role: "editor",
};

const citation: Citation = {
    type: "citation_data",
    kind: "document",
    ref: 1,
    doc_id: "doc-1",
    document_id: "doc-1",
    filename: "agreement.docx",
    page: 1,
    quote: "the quoted clause",
    document: {
        document_id: "doc-1",
        title: "agreement.docx",
        type: "docx",
        metadata: [],
        quotes: [{ quote: "the quoted clause", target: { page: 1 } }],
        version_id: null,
        version_number: null,
    },
};

const messages: Message[] = [
    { id: "m1", role: "assistant", content: "answer", citations: [citation] },
];

function renderView() {
    render(
        <PageChromeContext.Provider value={{ mobileActionsContainer: null }}>
            <ChatView
                chatId="chat-1"
                chat={chat}
                messages={messages}
                isResponseLoading={false}
                handleChat={vi.fn().mockResolvedValue("chat-1")}
                cancel={vi.fn()}
                canSend
            />
        </PageChromeContext.Provider>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
    });
});

describe("ChatView citation on a chat shared without its documents", () => {
    it("explains a refused document instead of doing nothing", async () => {
        listDocumentVersions.mockRejectedValue(
            new MikeApiError({ message: "Not found", status: 404 }),
        );
        renderView();

        fireEvent.click(screen.getByRole("button", { name: "citation pill" }));

        expect(
            await screen.findByText("Document not shared"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "The person who shared this chat has not shared its documents.",
            ),
        ).toBeInTheDocument();
    });

    it("stays quiet when the lookup merely failed", async () => {
        // A transport failure says nothing about the caller's access, so it
        // must not be reported as one.
        listDocumentVersions.mockRejectedValue(new Error("network"));
        renderView();

        fireEvent.click(screen.getByRole("button", { name: "citation pill" }));

        await waitFor(() => expect(listDocumentVersions).toHaveBeenCalled());
        expect(screen.queryByText("Document not shared")).not.toBeInTheDocument();
    });

    it("opens the citation normally when the versions are readable", async () => {
        listDocumentVersions.mockResolvedValue({
            current_version_id: "v1",
            versions: [
                {
                    id: "v1",
                    version_number: 1,
                    source: "upload",
                    created_at: "2026-08-18T00:00:00Z",
                    filename: "agreement.docx",
                },
            ],
        });
        renderView();

        fireEvent.click(screen.getByRole("button", { name: "citation pill" }));

        expect(await screen.findByTestId("panel-tabs")).toHaveTextContent("1");
        expect(screen.queryByText("Document not shared")).not.toBeInTheDocument();
    });
});

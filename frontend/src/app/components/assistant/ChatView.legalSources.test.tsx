import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, DocumentCitation, PanelDocument } from "../shared/types";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import { ChatView } from "./ChatView";

const { getDocument, getPanelDocument, listDocumentVersions } = vi.hoisted(() => ({
    getDocument: vi.fn(),
    getPanelDocument: vi.fn(),
    listDocumentVersions: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getDocument,
    getPanelDocument,
    listDocumentVersions,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        chats: [], renameChat: vi.fn(), deleteChat: vi.fn(),
        setCurrentChatId: vi.fn(), setNewChatMessages: vi.fn(),
    }),
}));
vi.mock("./ChatInput", () => ({ ChatInput: () => <div>Chat input</div> }));
vi.mock("./AssistantWorkflowModal", () => ({ AssistantWorkflowModal: () => null }));
vi.mock("./ChatAccessModal", () => ({ ChatAccessModal: () => null }));
// Only binary viewers are stubbed. Citation pills, ChatView, panel, title,
// annotation, sanitized text renderer and highlighting are the real components.
vi.mock("../shared/views/PdfView", () => ({ PdfView: () => <div>PDF canvas</div> }));
vi.mock("../shared/views/DocxView", () => ({ DocxView: () => <div>DOCX canvas</div> }));
vi.mock("../shared/views/SpreadsheetView", () => ({ SpreadsheetView: () => <div>Sheet canvas</div> }));

const body = "Article 1. Every person has the right to a fair hearing.\n\nArticle 2. The court shall give reasons.";
const quote = "Every person has the right to a fair hearing.";
const chat: Chat = {
    id: "chat-ldh", project_id: null, user_id: "owner", title: "Legal research",
    created_at: "2026-10-13T00:00:00Z", is_owner: true, access_role: "owner",
};
function sourceCitation(type: string, url = "https://example.org/official/source"): DocumentCitation {
    const id = "mcp:ldh-1:8:provider:4:1234";
    return {
        type: "citation_data", kind: "document", ref: 1,
        doc_id: "doc-0", document_id: id, filename: "Fair hearing", page: 1, quote,
        quotes: [{ page: 1, quote, verification: { verified: true } }],
        document: {
            document_id: id, title: "Fair hearing", type,
            metadata: [],
            actions: [{ type: "link", label: "Official source", url }],
            quotes: [{ quote, target: { subdocument_id: `${id}:text` } }],
            subdocuments: [{ document_id: `${id}:text`, title: "Fair hearing", type: "html", text: body }],
        } as PanelDocument, // legal_research is added to @mike/contracts by the backend port.
    };
}
function renderView(citation: DocumentCitation) {
    return render(
        <PageChromeContext.Provider value={{ mobileActionsContainer: null }}>
            <ChatView chatId={chat.id} chat={chat}
                messages={[{ id: "m1", role: "assistant", content: "The law provides a fair hearing [1].", events: [{ type: "content", text: "The law provides a fair hearing [1]." }], citations: [citation] }]}
                isResponseLoading={false} handleChat={vi.fn().mockResolvedValue(chat.id)}
                cancel={vi.fn()} onNewChat={vi.fn()} canSend />
        </PageChromeContext.Provider>,
    );
}
function clickInlineCitation() {
    const paragraph = screen.getByText(/The law provides a fair hearing/);
    fireEvent.click(within(paragraph).getByRole("button", { name: "Citation 1" }));
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    listDocumentVersions.mockRejectedValue(new Error("Inline sources have no stored versions"));
    getDocument.mockRejectedValue(new Error("Inline sources are not stored files"));
    getPanelDocument.mockRejectedValue(new Error("Inline content must not be refetched"));
    Element.prototype.scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollTo = vi.fn();
});

describe("Legal Data Hunter citation to document panel", () => {
    it.each([
        ["pdf", "PDF canvas"], ["docx", "DOCX canvas"], ["spreadsheet", "Sheet canvas"],
    ])("still resolves versions and opens the file viewer for uploaded %s citations", async (type, canvas) => {
        const citation = sourceCitation(type);
        citation.document_id = "uploaded-file";
        citation.document!.document_id = "uploaded-file";
        citation.document!.title = type === "spreadsheet" ? "Table.xlsx" : `Agreement.${type}`;
        citation.document!.subdocuments = undefined;
        citation.document!.actions = [];
        listDocumentVersions.mockResolvedValue({ current_version_id: "v1", versions: [{ id: "v1", version_number: 1 }] });
        getDocument.mockResolvedValue({ can_edit: false, can_delete: false });
        renderView(citation);
        clickInlineCitation();
        const panel = await screen.findByRole("tabpanel");
        expect(within(panel).getByText(canvas)).toBeVisible();
        expect(within(panel).queryByRole("article")).toBeNull();
        expect(listDocumentVersions).toHaveBeenCalledWith("uploaded-file");
        expect(getDocument).toHaveBeenCalledWith("uploaded-file");
        expect(getPanelDocument).not.toHaveBeenCalled();
    });

    it.each(["case", "legislation", "legal_research"])("opens an inline %s from the real citation pill, read-only and without file requests", async (type) => {
        renderView(sourceCitation(type));
        expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
        clickInlineCitation();
        const panel = await screen.findByRole("tabpanel");
        expect(within(panel).getByRole("heading", { name: "Fair hearing", level: 2 })).toBeVisible();
        const article = within(panel).getByRole("article");
        expect(article.textContent).toBe(`Fair hearing${body}`);
        expect(article.querySelector(".case-quote-highlight")).toHaveTextContent(quote);
        const officialSource = within(panel).getByRole("link", { name: "Official source" });
        expect(officialSource).toHaveAttribute("href", "https://example.org/official/source");
        expect(officialSource).toHaveAttribute("target", "_blank");
        expect(officialSource).toHaveAttribute("rel", "noopener noreferrer");
        expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
        expect(within(panel).queryByRole("button", { name: /download/i })).toBeNull();
        expect(screen.queryByText("PDF canvas")).toBeNull();
        expect(listDocumentVersions).not.toHaveBeenCalled();
        expect(getDocument).not.toHaveBeenCalled();
        expect(getPanelDocument).not.toHaveBeenCalled();

        // Dismiss the annotation without losing source text, then reopen it.
        fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
        expect(within(panel).queryByRole("region", { name: "Document annotation" })).toBeNull();
        expect(within(panel).getByRole("article").textContent).toBe(`Fair hearing${body}`);
        clickInlineCitation();
        await waitFor(() => expect(within(panel).getByRole("region", { name: "Document annotation" })).toBeVisible());
        expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    });

    it.each(["javascript:alert(1)", "data:text/html,unsafe", "//example.org/source", "https://user:secret@example.org/source", "https://", "not a url"])("does not render an unsafe official source action: %s", async (url) => {
        renderView(sourceCitation("case", url));
        clickInlineCitation();
        const panel = await screen.findByRole("tabpanel");
        expect(within(panel).queryByRole("link", { name: "Official source" })).toBeNull();
    });

    it("renders provider text as text, never executable HTML", async () => {
        const citation = sourceCitation("legislation");
        citation.document!.subdocuments![0].text = `${body}\n<img src=x onerror="alert(1)"><script>alert(1)</script>`;
        renderView(citation);
        clickInlineCitation();
        const article = within(await screen.findByRole("tabpanel")).getByRole("article");
        expect(article.textContent).toContain('<img src=x onerror="alert(1)">');
        expect(article.querySelector("img, script")).toBeNull();
    });
});

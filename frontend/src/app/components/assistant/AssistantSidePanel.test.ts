import { describe, expect, it } from "vitest";
import {
    assistantSidePanelTabId,
    defaultAssistantSidePanelWidth,
    maxAssistantSidePanelWidth,
    mergeAssistantSidePanelTab,
    reorderAssistantSidePanelTabs,
    upsertAssistantSidePanelTab,
    type AssistantSidePanelTab,
    type DocumentTab,
} from "./AssistantSidePanel";

function documentTab(id = "document-1"): DocumentTab {
    return {
        kind: "document",
        id,
        document: {
            document_id: id,
            title: "agreement.docx",
            type: "docx",
            metadata: [],
            quotes: [],
            version_id: null,
            version_number: null,
        },
    };
}

describe("mergeAssistantSidePanelTab", () => {
    it("returns the existing tab for the same plain-document version", () => {
        const existing = documentTab();
        const incoming = documentTab();

        expect(mergeAssistantSidePanelTab(existing, incoming)).toBe(existing);
    });

    it("replaces the displayed version in the same document tab", () => {
        const existing = documentTab();
        const incoming = documentTab();
        incoming.document.version_id = "version-2";
        incoming.document.version_number = 2;

        expect(mergeAssistantSidePanelTab(existing, incoming)).toBe(incoming);
    });

    it("changes citation context while preserving state for the same version", () => {
        const existing: AssistantSidePanelTab = {
            ...documentTab(),
            document: {
                ...documentTab().document,
                version_id: "citation-version",
                version_number: 4,
            },
            warning: "Preserved warning",
            initialScrollTop: 240,
        };
        const incoming: AssistantSidePanelTab = {
            ...documentTab(),
            kind: "citation",
            document: {
                ...documentTab().document,
                title: "renamed-agreement.docx",
                version_id: "citation-version",
                version_number: 4,
            },
            citation: {
                type: "citation_data",
                kind: "document",
                ref: 1,
                doc_id: "doc-0",
                document_id: "document-1",
                filename: "renamed-agreement.docx",
                page: 2,
                quote: "Relevant clause",
                quotes: [{ page: 2, quote: "Relevant clause" }],
            },
        };

        expect(mergeAssistantSidePanelTab(existing, incoming)).toMatchObject({
            kind: "citation",
            id: "document-1",
            document: {
                document_id: "document-1",
                version_id: "citation-version",
                version_number: 4,
            },
            warning: "Preserved warning",
            initialScrollTop: 240,
        });
    });
});

describe("versioned panel tab identity", () => {
    it("uses one id for every version of a document", () => {
        const versionOne = documentTab().document;
        versionOne.version_id = "version-1";
        const versionTwo = { ...versionOne, version_id: "version-2" };

        expect(assistantSidePanelTabId(versionOne)).toBe(
            assistantSidePanelTabId(versionTwo),
        );
    });

    it("reuses the tab when another version is opened", () => {
        const first = documentTab();
        first.document.version_id = "version-1";
        const second = documentTab();
        second.document.version_id = "version-2";

        expect(upsertAssistantSidePanelTab([first], second)).toEqual([second]);
    });
});

describe("reorderAssistantSidePanelTabs", () => {
    const tabs = [documentTab("a"), documentTab("b"), documentTab("c")];

    it("moves a tab before the drop target", () => {
        expect(
            reorderAssistantSidePanelTabs(tabs, "c", "a", "before").map(
                (tab) => tab.id,
            ),
        ).toEqual(["c", "a", "b"]);
    });

    it("moves a tab after the drop target", () => {
        expect(
            reorderAssistantSidePanelTabs(tabs, "a", "b", "after").map(
                (tab) => tab.id,
            ),
        ).toEqual(["b", "a", "c"]);
    });

    it("moves a tab to the right end after the last tab", () => {
        expect(
            reorderAssistantSidePanelTabs(tabs, "a", "c", "after").map(
                (tab) => tab.id,
            ),
        ).toEqual(["b", "c", "a"]);
    });

    it("keeps the existing array when the drop does not change order", () => {
        expect(reorderAssistantSidePanelTabs(tabs, "a", "b", "before")).toBe(
            tabs,
        );
    });
});

describe("side panel width", () => {
    it("opens at half the page beside one chat", () => {
        expect(defaultAssistantSidePanelWidth(1456, 1)).toBe(700);
    });

    it("opens at two fifths of the page beside two chats", () => {
        expect(defaultAssistantSidePanelWidth(1456, 2)).toBe(560);
        expect(defaultAssistantSidePanelWidth(2056, 2)).toBe(800);
    });

    it("leaves every chat its minimum width", () => {
        expect(maxAssistantSidePanelWidth(1456, 1)).toBe(1000);
        expect(maxAssistantSidePanelWidth(1456, 2)).toBe(600);
        // Never below the panel's own minimum, however narrow the page.
        expect(maxAssistantSidePanelWidth(900, 2)).toBe(300);
        expect(defaultAssistantSidePanelWidth(1100, 2)).toBe(300);
    });
});

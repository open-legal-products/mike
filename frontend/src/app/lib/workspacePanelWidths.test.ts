import { describe, expect, it } from "vitest";
import {
    fitPanelWidths,
    fitsWithExplorer,
    resizeChatSplit,
    resizePanel,
} from "./workspacePanelWidths";

const widths = { explorer: 280, chat: 420, sideChat: 420 };
const oneChat = { explorerCollapsed: false, sideChatOpen: false };
const twoChats = { explorerCollapsed: false, sideChatOpen: true };

/** What is left for the document view. */
function documentWidth(
    fitted: typeof widths,
    workspaceWidth: number,
    layout: typeof oneChat,
) {
    return (
        workspaceWidth -
        (layout.explorerCollapsed ? 42 : fitted.explorer + 12) -
        fitted.chat -
        (layout.sideChatOpen ? fitted.sideChat + 6 : 0)
    );
}

describe("fitPanelWidths", () => {
    it("leaves panels that fit alone", () => {
        expect(fitPanelWidths(widths, 1400, oneChat)).toBe(widths);
        expect(fitPanelWidths(widths, 1600, twoChats)).toBe(widths);
    });

    it("ignores a closed side chat", () => {
        // 280 + 420 + 12 leaves the document 388 of 1100.
        expect(fitPanelWidths(widths, 1100, oneChat)).toBe(widths);
    });

    it("narrows the panels when a second chat opens, keeping the document's minimum", () => {
        const fitted = fitPanelWidths(widths, 1300, twoChats);
        expect(fitted.explorer).toBeLessThan(widths.explorer);
        expect(fitted.chat).toBeLessThan(widths.chat);
        expect(fitted.sideChat).toBeLessThan(widths.sideChat);
        expect(documentWidth(fitted, 1300, twoChats)).toBeCloseTo(320);
    });

    it("stops at each panel's minimum", () => {
        expect(fitPanelWidths(widths, 900, twoChats)).toEqual({
            explorer: 160,
            chat: 320,
            sideChat: 320,
        });
    });

    it("leaves a collapsed explorer's width untouched", () => {
        const collapsed = { explorerCollapsed: true, sideChatOpen: true };
        const fitted = fitPanelWidths(widths, 1100, collapsed);
        expect(fitted.explorer).toBe(280);
        expect(documentWidth(fitted, 1100, collapsed)).toBeCloseTo(320);
    });
});

describe("resizePanel", () => {
    it("holds a panel to what the others and the document leave", () => {
        // 1400 - 320 (document) - 18 (dividers) - 280 - 420 = 362.
        expect(resizePanel(widths, "chat", 900, 1400, twoChats).chat).toBe(362);
        expect(resizePanel(widths, "chat", 900, 1400, oneChat).chat).toBe(788);
    });

    it("never goes below the panel's minimum", () => {
        expect(resizePanel(widths, "chat", 10, 1400, oneChat).chat).toBe(320);
        expect(
            resizePanel(widths, "explorer", 10, undefined, oneChat).explorer,
        ).toBe(160);
    });
});

describe("resizeChatSplit", () => {
    it("trades width between the chats, leaving the document alone", () => {
        expect(resizeChatSplit(widths, 50)).toEqual({
            explorer: 280,
            chat: 470,
            sideChat: 370,
        });
    });

    it("keeps both chats at their minimum", () => {
        expect(resizeChatSplit(widths, 500).sideChat).toBe(320);
        expect(resizeChatSplit(widths, -500).chat).toBe(320);
    });
});

describe("fitsWithExplorer", () => {
    it("says when a second chat needs the explorer's room", () => {
        expect(fitsWithExplorer(1100, false)).toBe(true);
        expect(fitsWithExplorer(1100, true)).toBe(false);
        expect(fitsWithExplorer(1200, true)).toBe(true);
    });
});

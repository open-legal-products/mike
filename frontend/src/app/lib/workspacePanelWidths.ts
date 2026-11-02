/**
 * Widths of the IDE's resizable panels. The document view takes whatever the
 * explorer and the chat panels leave, and never less than `DOCUMENT_MIN`.
 */
export type WorkspacePanelWidths = {
    explorer: number;
    chat: number;
    /** The second chat panel, when one is open beside the first. */
    sideChat: number;
};

export type WorkspacePanelLayout = {
    explorerCollapsed: boolean;
    sideChatOpen: boolean;
};

export const EXPLORER_MIN = 160;
export const EXPLORER_DEFAULT = 280;
export const DOCUMENT_MIN = 320;
export const CHAT_MIN = 320;
export const CHAT_DEFAULT = 420;
const DIVIDER_WIDTH = 6;
const COLLAPSED_EXPLORER_FOOTPRINT = 42;

type PanelKey = keyof WorkspacePanelWidths;

const PANEL_MIN: Record<PanelKey, number> = {
    explorer: EXPLORER_MIN,
    chat: CHAT_MIN,
    sideChat: CHAT_MIN,
};

function shownPanels(layout: WorkspacePanelLayout): PanelKey[] {
    return [
        ...(layout.explorerCollapsed ? [] : (["explorer"] as const)),
        "chat" as const,
        ...(layout.sideChatOpen ? (["sideChat"] as const) : []),
    ];
}

/** What the resizable panels may share once the document has its minimum. */
function availablePanelWidth(
    workspaceWidth: number,
    layout: WorkspacePanelLayout,
): number {
    const chrome =
        (layout.explorerCollapsed
            ? COLLAPSED_EXPLORER_FOOTPRINT
            : DIVIDER_WIDTH * 2) +
        (layout.sideChatOpen ? DIVIDER_WIDTH : 0);
    return workspaceWidth - DOCUMENT_MIN - chrome;
}

/**
 * Shrinks the shown panels so the document keeps its minimum width, taking
 * from each in proportion to what it holds above its own minimum. Panels that
 * already fit, and panels that are not shown, are left as they are.
 */
export function fitPanelWidths(
    widths: WorkspacePanelWidths,
    workspaceWidth: number,
    layout: WorkspacePanelLayout,
): WorkspacePanelWidths {
    const panels = shownPanels(layout);
    const available = availablePanelWidth(workspaceWidth, layout);
    const total = panels.reduce((sum, key) => sum + widths[key], 0);
    if (total <= available) return widths;

    const minimumTotal = panels.reduce((sum, key) => sum + PANEL_MIN[key], 0);
    const extraTotal = total - minimumTotal;
    if (extraTotal <= 0) return widths;
    const scale = Math.max(0, available - minimumTotal) / extraTotal;

    const next = { ...widths };
    for (const key of panels) {
        next[key] = PANEL_MIN[key] + (widths[key] - PANEL_MIN[key]) * scale;
    }
    return next;
}

/**
 * Sets one panel's width, held between its minimum and what the other shown
 * panels and the document's minimum leave it. An unknown workspace width
 * (not laid out yet) applies only the minimum.
 */
export function resizePanel(
    widths: WorkspacePanelWidths,
    panel: PanelKey,
    requestedWidth: number,
    workspaceWidth: number | undefined,
    layout: WorkspacePanelLayout,
): WorkspacePanelWidths {
    const minimum = PANEL_MIN[panel];
    let width = Math.max(minimum, requestedWidth);
    if (workspaceWidth) {
        const others = shownPanels(layout)
            .filter((key) => key !== panel)
            .reduce((sum, key) => sum + widths[key], 0);
        const maximum = Math.max(
            minimum,
            availablePanelWidth(workspaceWidth, layout) - others,
        );
        width = Math.min(width, maximum);
    }
    return width === widths[panel] ? widths : { ...widths, [panel]: width };
}

/**
 * Moves the line between the two chat panels `dx` pixels to the right. One
 * chat gives the other its width, so the document view does not move.
 */
export function resizeChatSplit(
    widths: WorkspacePanelWidths,
    dx: number,
): WorkspacePanelWidths {
    const total = widths.chat + widths.sideChat;
    const chat = Math.min(
        total - CHAT_MIN,
        Math.max(CHAT_MIN, widths.chat + dx),
    );
    if (total < CHAT_MIN * 2 || chat === widths.chat) return widths;
    return { ...widths, chat, sideChat: total - chat };
}

/** Whether every panel fits at its minimum with the explorer expanded. */
export function fitsWithExplorer(
    workspaceWidth: number,
    sideChatOpen: boolean,
): boolean {
    const layout = { explorerCollapsed: false, sideChatOpen };
    const minimumTotal = shownPanels(layout).reduce(
        (sum, key) => sum + PANEL_MIN[key],
        0,
    );
    return availablePanelWidth(workspaceWidth, layout) >= minimumTotal;
}

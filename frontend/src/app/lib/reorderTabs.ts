export type TabDropPosition = "before" | "after";

export function reorderTabs<T>(
    tabs: T[],
    draggedTabId: string,
    targetTabId: string,
    position: TabDropPosition,
    getId: (tab: T) => string,
): T[] {
    const draggedIndex = tabs.findIndex((tab) => getId(tab) === draggedTabId);
    const targetIndex = tabs.findIndex((tab) => getId(tab) === targetTabId);
    if (draggedIndex < 0 || targetIndex < 0 || draggedTabId === targetTabId) {
        return tabs;
    }

    const next = tabs.slice();
    const [draggedTab] = next.splice(draggedIndex, 1);
    const remainingTargetIndex = next.findIndex(
        (tab) => getId(tab) === targetTabId,
    );
    next.splice(
        position === "after" ? remainingTargetIndex + 1 : remainingTargetIndex,
        0,
        draggedTab,
    );

    return next.every((tab, index) => tab === tabs[index]) ? tabs : next;
}

import type { Chat, TabularReview } from "@/app/components/shared/types";
import { chatActivityAt } from "./chatActivity";

export type SidebarHistoryItem =
    | { kind: "chat"; item: Chat }
    | { kind: "review"; item: TabularReview };

function activityTime(item: Chat | TabularReview): number {
    return Date.parse(chatActivityAt(item) ?? "") || 0;
}

/** Only show the portion for which both paginated sources have been read. */
export function mergeSidebarHistory(
    chats: Chat[],
    reviews: TabularReview[],
    hasMoreChats: boolean,
    hasMoreReviews: boolean,
): SidebarHistoryItem[] {
    // Without this boundary, an old review could appear above newer chats
    // still on the next page (or vice versa). Keep older rows buffered.
    const oldest = (items: (Chat | TabularReview)[]) =>
        items.reduce((time, item) => Math.min(time, activityTime(item)), Infinity);
    const cutoff = Math.max(
        hasMoreChats ? oldest(chats) : -Infinity,
        hasMoreReviews ? oldest(reviews) : -Infinity,
    );
    const entries: SidebarHistoryItem[] = [
        ...chats.map((item): SidebarHistoryItem => ({ kind: "chat", item })),
        ...reviews.map((item): SidebarHistoryItem => ({ kind: "review", item })),
    ];
    return entries
        .filter(({ item }) => activityTime(item) >= cutoff)
        .sort((a, b) => activityTime(b.item) - activityTime(a.item)
            || `${a.kind}:${a.item.id}`.localeCompare(`${b.kind}:${b.item.id}`));
}

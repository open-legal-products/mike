import { describe, expect, it } from "vitest";
import type { Chat, TabularReview } from "@/app/components/shared/types";
import { mergeSidebarHistory } from "./sidebarHistory";

const chat = (id: string, day: number) => ({
    id, created_at: "2026-09-01T00:00:00Z", updated_at: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`,
}) as Chat;
const review = (id: string, day: number, projectId: string | null = null) => ({
    ...chat(id, day), project_id: projectId,
}) as TabularReview;
const ids = (items: ReturnType<typeof mergeSidebarHistory>) => items.map(({ item }) => item.id);

describe("sidebar history", () => {
    it("interleaves chats and both review scopes by updated time, regardless of creation time", () => {
        expect(ids(mergeSidebarHistory(
            [chat("chat", 14)], [review("standalone", 12), review("project", 15, "p1")], false, false,
        ))).toEqual(["project", "chat", "standalone"]);
    });

    it("buffers older reviews until the chat pages reach them", () => {
        const chats = [chat("new-chat", 15), chat("chat-boundary", 12)];
        const reviews = [review("new-review", 14), review("old-review", 2)];
        expect(ids(mergeSidebarHistory(chats, reviews, true, false))).toEqual([
            "new-chat", "new-review", "chat-boundary",
        ]);
        expect(ids(mergeSidebarHistory([...chats, chat("next-chat", 10)], reviews, false, false))).toEqual([
            "new-chat", "new-review", "chat-boundary", "next-chat", "old-review",
        ]);
    });

    it("also buffers chats while newer reviews remain on later pages", () => {
        const chats = [chat("new-chat", 15), chat("old-chat", 1)];
        const reviews = [review("review-boundary", 14)];
        expect(ids(mergeSidebarHistory(chats, reviews, false, true))).toEqual(["new-chat", "review-boundary"]);
        expect(ids(mergeSidebarHistory(chats, [...reviews, review("next-review", 5)], false, false))).toEqual([
            "new-chat", "review-boundary", "next-review", "old-chat",
        ]);
    });

    it("uses creation time for legacy entries and keeps equal timestamps deterministic", () => {
        const legacy = { id: "legacy", created_at: "2026-10-15T00:00:00Z" } as Chat;
        const result = mergeSidebarHistory([chat("same-id", 14), legacy], [review("same-id", 14)], false, false);
        expect(result.map(({ kind, item }) => `${kind}:${item.id}`)).toEqual([
            "chat:legacy", "chat:same-id", "review:same-id",
        ]);
    });
});

import { describe, expect, it } from "vitest";
import {
    chatActivityAt,
    sortChatsByActivity,
    touchChatActivity,
} from "./chatActivity";

describe("chat activity", () => {
    it("orders chats by their latest update instead of creation", () => {
        const chats = sortChatsByActivity([
            {
                id: "newer-created",
                created_at: "2026-09-20T12:00:00Z",
                updated_at: "2026-09-20T12:00:00Z",
            },
            {
                id: "recently-active",
                created_at: "2026-09-10T12:00:00Z",
                updated_at: "2026-09-21T12:00:00Z",
            },
        ]);

        expect(chats.map((chat) => chat.id)).toEqual([
            "recently-active",
            "newer-created",
        ]);
    });

    it("falls back to creation time for legacy rows", () => {
        expect(
            chatActivityAt({
                id: "legacy",
                created_at: "2026-09-20T12:00:00Z",
            }),
        ).toBe("2026-09-20T12:00:00Z");
    });

    it("moves a touched chat to the front", () => {
        const chats = touchChatActivity(
            [
                { id: "first", updated_at: "2026-09-21T12:00:00Z" },
                { id: "second", updated_at: "2026-09-20T12:00:00Z" },
            ],
            "second",
            "2026-09-22T12:00:00Z",
        );

        expect(chats.map((chat) => chat.id)).toEqual(["second", "first"]);
    });

    it("preserves the array when the chat is not present", () => {
        const chats = [{ id: "first", updated_at: "2026-09-21T12:00:00Z" }];

        expect(touchChatActivity(chats, "missing")).toBe(chats);
    });
});

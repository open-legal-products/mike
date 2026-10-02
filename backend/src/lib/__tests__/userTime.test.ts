import { describe, expect, it, vi } from "vitest";
import {
    MESSAGE_TIME_PROMPT,
    answerTimeStamp,
    formatMessageTime,
    normalizeTimeZone,
    resolveRequestTimeZone,
    userMessageTimeStamp,
} from "../userTime";
import {
    buildMessages,
    enrichWithPriorEvents,
    loadUserMessageSentTimes,
} from "../../modules/chat/engine/contextBuilders";
import { buildTabularMessages } from "../../modules/tabular/tabular.chats";
import type { Db } from "../supabase";

// 13:05 UTC is 14:05 in London (BST) and 09:05 in New York (EDT).
const NOW = new Date("2026-10-01T13:05:00Z");

describe("user time helpers", () => {
    it("accepts IANA zones and rejects anything else", () => {
        expect(normalizeTimeZone("Europe/London")).toBe("Europe/London");
        expect(normalizeTimeZone(" America/New_York ")).toBe(
            "America/New_York",
        );
        expect(normalizeTimeZone("UTC")).toBe("UTC");
        for (const bad of ["Mars/Base", "", "   ", 42, null, undefined, "x".repeat(65)])
            expect(normalizeTimeZone(bad)).toBeNull();
    });

    it("formats the date and time in the user's zone", () => {
        expect(formatMessageTime(NOW, "Europe/London")).toBe(
            "Thu 1 Oct 2026, 14:05",
        );
        expect(formatMessageTime(NOW, "America/New_York")).toBe(
            "Thu 1 Oct 2026, 09:05",
        );
        // Just after midnight is 00:30 on the next day, never "24:30".
        expect(
            formatMessageTime(new Date("2026-10-01T23:30:00Z"), "Europe/London"),
        ).toBe("Fri 2 Oct 2026, 00:30");
        // Late evening in Los Angeles is already tomorrow in UTC.
        expect(
            formatMessageTime(new Date("2026-10-02T03:00:00Z"), "America/Los_Angeles"),
        ).toBe("Thu 1 Oct 2026, 20:00");
    });

    it("explains the stamps with fixed text and formats both stamps", () => {
        expect(MESSAGE_TIME_PROMPT).toContain("[Sent: …]");
        expect(MESSAGE_TIME_PROMPT).toContain("[Answered: …]");
        expect(MESSAGE_TIME_PROMPT).toContain(
            "The latest stamp is the current date and time.",
        );
        // No date in the system prompt: it would change the cached prefix.
        expect(MESSAGE_TIME_PROMPT).not.toMatch(/20\d\d/);
        expect(userMessageTimeStamp(NOW, "Europe/London")).toBe(
            "[Sent: Thu 1 Oct 2026, 14:05 (Europe/London)]",
        );
        expect(answerTimeStamp(NOW, "Europe/London")).toBe(
            "[Answered: Thu 1 Oct 2026, 14:05 (Europe/London)]",
        );
    });
});

describe("message time stamps", () => {
    const history = [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Follow-up" },
    ];

    it("explains the stamps in the system prompt and stamps each user message", () => {
        const [system, first, answer, latest] = buildMessages(
            history,
            [],
            undefined,
            undefined,
            false,
            undefined,
            "append",
            {
                timeZone: "Europe/London",
                now: NOW,
                userSentAt: ["2026-09-30T08:00:00Z", "2026-10-01T13:04:00Z"],
            },
        ) as { role: string; content: string }[];
        expect(system.content).toContain(MESSAGE_TIME_PROMPT);
        expect(first.content).toBe(
            "[Sent: Wed 30 Sep 2026, 09:00 (Europe/London)]\nFirst question",
        );
        expect(answer.content).toBe("First answer");
        expect(latest.content).toBe(
            "[Sent: Thu 1 Oct 2026, 14:04 (Europe/London)]\nFollow-up",
        );
    });

    it("keeps earlier turns byte-identical between requests for prompt caching", () => {
        const sentAt = ["2026-09-30T08:00:00Z", "2026-10-01T13:04:00Z"];
        const build = (now: Date) =>
            buildMessages(history, [], undefined, undefined, false, undefined, "append", {
                timeZone: "Europe/London",
                now,
                userSentAt: sentAt,
            });
        // A later clock, even on another day: everything is identical.
        expect(build(new Date("2026-10-05T18:00:00Z"))).toEqual(build(NOW));
    });

    it("stamps only the newest message with the current time when nothing is stored", () => {
        const [, first, , latest] = buildMessages(
            history,
            [],
            undefined,
            undefined,
            false,
            undefined,
            "append",
            { timeZone: "UTC", now: NOW, userSentAt: [null, null] },
        ) as { content: string }[];
        expect(first.content).toBe("First question");
        expect(latest.content).toBe(
            "[Sent: Thu 1 Oct 2026, 13:05 (UTC)]\nFollow-up",
        );
    });

    it("stamps tabular review chat messages the same way", () => {
        const [system, first] = buildTabularMessages(
            history,
            { documents: [], columns: [] } as never,
            "Leases",
            {
                timeZone: "Europe/London",
                now: NOW,
                userSentAt: ["2026-09-30T08:00:00Z", null],
            },
        ) as { content: string }[];
        expect(system.content).toContain(MESSAGE_TIME_PROMPT);
        expect(first.content).toMatch(/^\[Sent: Wed 30 Sep 2026, 09:00/);
    });

    it("stamps the user's answers with when they responded", async () => {
        const answers = {
            type: "ask_inputs_response",
            assistant_message_id: "a1",
            ask_event_id: "e1",
            recorded_at: "2026-10-02T09:30:00Z",
            responses: [{ id: "q1", kind: "text", answer: "Net 30" }],
        };
        const query = {
            select: () => query,
            eq: () => query,
            not: () => query,
            order: () => query,
            limit: () =>
                Promise.resolve({ data: [{ content: [answers] }], error: null }),
        };
        const db = { from: () => query } as unknown as Db;
        const conversation = [
            { role: "user", content: "Draft the payment clause" },
            { role: "assistant", content: "What payment term?" },
        ];
        const [, assistant] = await enrichWithPriorEvents(
            conversation,
            "chat-1",
            db,
            {},
            undefined,
            "chat_messages",
            "Europe/London",
        );
        expect(assistant.content).toContain(
            "- user responded [Answered: Fri 2 Oct 2026, 10:30 (Europe/London)]",
        );
        // Without a time zone (e.g. callers that do not stamp), no stamp.
        const [, unstamped] = await enrichWithPriorEvents(
            conversation,
            "chat-1",
            db,
            {},
        );
        expect(unstamped.content).not.toContain("[Answered:");
    });

    it("aligns stored send times to the history from the newest message back", async () => {
        const rows = [
            { created_at: "2026-09-29T08:00:00Z" }, // older than the history sent
            { created_at: "2026-09-30T08:00:00Z" },
            { created_at: "2026-10-01T13:04:00Z" },
        ];
        const query = {
            select: () => query,
            eq: () => query,
            order: () => Promise.resolve({ data: rows, error: null }),
        };
        const db = { from: vi.fn(() => query) } as unknown as Db;
        expect(
            await loadUserMessageSentTimes(db, "chat_messages", "chat-1", history),
        ).toEqual(["2026-09-30T08:00:00Z", "2026-10-01T13:04:00Z"]);
        expect(
            await loadUserMessageSentTimes(db, "chat_messages", null, history),
        ).toEqual([null, null]);
    });

    it("leaves an unsaved continuation message unstamped without shifting the rest", async () => {
        const rows = [
            { created_at: "2026-09-30T08:00:00Z" },
            { created_at: "2026-10-01T13:04:00Z" },
        ];
        const query = {
            select: () => query,
            eq: () => query,
            order: () => Promise.resolve({ data: rows, error: null }),
        };
        const db = { from: vi.fn(() => query) } as unknown as Db;
        const continued = [
            ...history,
            { role: "assistant", content: "Which matter?" },
            { role: "user", content: "The Acme one" },
        ] as typeof history;
        expect(
            await loadUserMessageSentTimes(
                db,
                "chat_messages",
                "chat-1",
                continued,
                true,
            ),
        ).toEqual(["2026-09-30T08:00:00Z", "2026-10-01T13:04:00Z", null]);
    });
});

describe("resolveRequestTimeZone", () => {
    it("uses the valid browser time zone from each request", () => {
        expect(resolveRequestTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
        expect(resolveRequestTimeZone(" Europe/London ")).toBe("Europe/London");
    });

    it.each([undefined, null, "", "Not/AZone", 42, "x".repeat(65)])(
        "falls back to UTC for a missing or invalid time zone: %j",
        (requested) => {
            expect(resolveRequestTimeZone(requested)).toBe("UTC");
        },
    );
});

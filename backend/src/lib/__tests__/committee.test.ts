import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeWithProvider, streamWithProvider } = vi.hoisted(() => ({
    completeWithProvider: vi.fn(),
    streamWithProvider: vi.fn(),
}));

vi.mock("../llm/providers", () => ({
    completeWithProvider: (...args: unknown[]) => completeWithProvider(...args),
    streamWithProvider: (...args: unknown[]) => streamWithProvider(...args),
}));

import { completeText, streamChatWithTools } from "../llm";
import type { CommitteeModel } from "../llm/types";

const COMMITTEE: CommitteeModel = {
    id: "user-committee/panel",
    label: "Panel",
    members: ["claude-opus-5", "gemini-3.5-flash"],
    chair: "gpt-5.5",
    strategy: "synthesize",
};

const committees = [COMMITTEE];

beforeEach(() => {
    vi.clearAllMocks();
    completeWithProvider.mockImplementation(
        async ({ model }: { model: string }) => `answer from ${model}`,
    );
});

describe("committee completion", () => {
    it("asks every member, then hands their answers to the chair", async () => {
        const text = await completeText({
            model: COMMITTEE.id,
            systemPrompt: "Be precise.",
            user: "Is this mark registrable?",
            committeeModels: committees,
        });

        const models = completeWithProvider.mock.calls.map(
            ([params]) => params.model,
        );
        expect(models).toEqual([
            "claude-opus-5",
            "gemini-3.5-flash",
            "gpt-5.5",
        ]);
        expect(text).toBe("answer from gpt-5.5");

        const chairCall = completeWithProvider.mock.calls.at(-1)![0];
        expect(chairCall.user).toContain("answer from claude-opus-5");
        expect(chairCall.user).toContain("answer from gemini-3.5-flash");
        expect(chairCall.user).toContain("Is this mark registrable?");
        expect(chairCall.systemPrompt).toContain("Be precise.");
    });

    it("runs the members concurrently rather than one after another", async () => {
        let running = 0;
        let peak = 0;
        completeWithProvider.mockImplementation(async () => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running -= 1;
            return "ok";
        });

        await completeText({
            model: COMMITTEE.id,
            user: "question",
            committeeModels: committees,
        });

        expect(peak).toBe(COMMITTEE.members.length);
    });

    it("passes each member its own extra system prompt", async () => {
        await completeText({
            model: "user-committee/mixed",
            systemPrompt: "Base.",
            user: "question",
            committeeModels: [
                {
                    id: "user-committee/mixed",
                    label: "Mixed",
                    members: [
                        { model: "claude-opus-5", systemPrompt: "Be sceptical." },
                        "gemini-3.5-flash",
                    ],
                    chair: "gpt-5.5",
                },
            ],
        });

        const first = completeWithProvider.mock.calls[0][0];
        expect(first.systemPrompt).toBe("Base.\n\nBe sceptical.");
        const second = completeWithProvider.mock.calls[1][0];
        expect(second.systemPrompt).toBe("Base.");
    });

    it("refuses a committee that chairs itself", async () => {
        await expect(
            completeText({
                model: "user-committee/self",
                user: "question",
                committeeModels: [
                    {
                        id: "user-committee/self",
                        members: ["claude-opus-5", "gpt-5.5"],
                        chair: "user-committee/self",
                    },
                ],
            }),
        ).rejects.toThrow(/cannot use itself as the chair/);
    });

    it("refuses a committee that lists itself as a member", async () => {
        await expect(
            completeText({
                model: "user-committee/self-member",
                user: "question",
                committeeModels: [
                    {
                        id: "user-committee/self-member",
                        members: ["user-committee/self-member", "gpt-5.5"],
                        chair: "claude-opus-5",
                    },
                ],
            }),
        ).rejects.toThrow(/cannot include itself as member/);
    });

    it("breaks a cycle between two committees", async () => {
        const cyclic: CommitteeModel[] = [
            {
                id: "user-committee/a",
                members: ["user-committee/b", "gpt-5.5"],
                chair: "claude-opus-5",
            },
            {
                id: "user-committee/b",
                members: ["user-committee/a", "gpt-5.5"],
                chair: "claude-opus-5",
            },
        ];
        await expect(
            completeText({
                model: "user-committee/a",
                user: "question",
                committeeModels: cyclic,
            }),
        ).rejects.toThrow(/Circular committee reference/);
    });

    it("leaves an ordinary model on the normal provider path", async () => {
        await completeText({ model: "claude-opus-5", user: "question" });
        expect(completeWithProvider).toHaveBeenCalledTimes(1);
        expect(completeWithProvider.mock.calls[0][0].model).toBe(
            "claude-opus-5",
        );
    });
});

describe("committee streaming", () => {
    it("answers without tools and emits the synthesis as one delta", async () => {
        const onContentDelta = vi.fn();
        const result = await streamChatWithTools({
            model: COMMITTEE.id,
            systemPrompt: "Be precise.",
            messages: [{ role: "user", content: "Is this mark registrable?" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "read_document",
                        description: "",
                        parameters: {},
                    },
                },
            ],
            committeeModels: committees,
            callbacks: { onContentDelta },
        });

        expect(result.fullText).toBe("answer from gpt-5.5");
        expect(onContentDelta).toHaveBeenCalledWith("answer from gpt-5.5");
        expect(streamWithProvider).not.toHaveBeenCalled();
        // The members must be told the tools are unavailable rather than
        // inventing tool work they cannot do.
        expect(completeWithProvider.mock.calls[0][0].systemPrompt).toContain(
            "tools are not available in committee mode",
        );
    });

    it("leaves an ordinary model on the normal streaming path", async () => {
        streamWithProvider.mockResolvedValue({ fullText: "streamed" });
        const result = await streamChatWithTools({
            model: "claude-opus-5",
            systemPrompt: "",
            messages: [{ role: "user", content: "hi" }],
        });
        expect(result.fullText).toBe("streamed");
        expect(streamWithProvider).toHaveBeenCalledTimes(1);
    });
});

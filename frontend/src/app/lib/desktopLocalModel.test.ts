import { describe, expect, it, vi } from "vitest";
import { initializeDesktopLocalModel } from "./desktopLocalModel";

const emptyProfile = () => ({
    lastSelectedChatModel: null as string | null,
    legalResearchUs: true,
});

describe("desktop local model default", () => {
    it.each(["ollama/qwen3.5:2b", "ollama/qwen3.5:4b"])(
        "selects ready starter %s with online research off",
        async (model) => {
            const profile = emptyProfile();
            const updated = {
                ...profile,
                lastSelectedChatModel: model,
                legalResearchUs: false,
            };
            const save = vi.fn().mockResolvedValue(updated);
            expect(
                await initializeDesktopLocalModel(
                    profile,
                    {
                        readyLocalModel: async () => model,
                    },
                    save,
                ),
            ).toBe(updated);
            expect(save).toHaveBeenCalledWith({
                lastSelectedChatModel: model,
                legalResearchUs: false,
            });
            expect(profile.lastSelectedChatModel).toBeNull();
        },
    );

    it("does nothing in an ordinary browser or hosted desktop session", async () => {
        const profile = emptyProfile();
        const save = vi.fn();
        expect(
            await initializeDesktopLocalModel(profile, undefined, save),
        ).toBe(profile);
        expect(
            await initializeDesktopLocalModel(
                profile,
                { readyLocalModel: async () => null },
                save,
            ),
        ).toBe(profile);
        expect(save).not.toHaveBeenCalled();
    });

    it("preserves a saved model and research preference without querying the runtime", async () => {
        const profile = {
            ...emptyProfile(),
            lastSelectedChatModel: "gpt-5.6-luna",
        };
        const readyLocalModel = vi.fn();
        const save = vi.fn();
        expect(
            await initializeDesktopLocalModel(
                profile,
                { readyLocalModel },
                save,
            ),
        ).toBe(profile);
        expect(readyLocalModel).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it("ignores an unexpected model instead of changing the user's default", async () => {
        const profile = emptyProfile();
        const save = vi.fn();
        expect(
            await initializeDesktopLocalModel(
                profile,
                { readyLocalModel: async () => "remote/model" },
                save,
            ),
        ).toBe(profile);
        expect(save).not.toHaveBeenCalled();
    });

    it("does not persist a result after the profile load becomes stale", async () => {
        const profile = emptyProfile();
        const save = vi.fn();
        expect(
            await initializeDesktopLocalModel(
                profile,
                { readyLocalModel: async () => "ollama/qwen3.5:4b" },
                save,
                () => false,
            ),
        ).toBe(profile);
        expect(save).not.toHaveBeenCalled();
    });

    it("retains the valid profile when the runtime or preference save fails", async () => {
        const profile = emptyProfile();
        const save = vi.fn().mockRejectedValue(new Error("Save unavailable"));
        expect(
            await initializeDesktopLocalModel(
                profile,
                {
                    readyLocalModel: async () => {
                        throw new Error("Runtime unavailable");
                    },
                },
                save,
            ),
        ).toBe(profile);
        expect(save).not.toHaveBeenCalled();
        expect(
            await initializeDesktopLocalModel(
                profile,
                { readyLocalModel: async () => "ollama/qwen3.5:4b" },
                save,
            ),
        ).toBe(profile);
    });
});

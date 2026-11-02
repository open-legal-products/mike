import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryCurrent } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { useMemoryFileController } from "./useMemoryFileController";

vi.mock("@/app/lib/userFacingError", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/userFacingError")>()),
    notifyError: vi.fn(),
}));

function memory(overrides: Partial<MemoryCurrent> = {}): MemoryCurrent {
    return {
        enabled: true,
        content: "Remember this.",
        revision: 3,
        hash: null,
        updated_at: null,
        updated_by: null,
        source: "manual",
        status: "processing",
        ...overrides,
    };
}

function renderController(loadMemory: (signal?: AbortSignal) => Promise<MemoryCurrent>) {
    return renderHook(() =>
        useMemoryFileController({
            canEdit: true,
            mutationBlocked: false,
            flushOnUnmount: false,
            loadMemory,
            saveMemory: vi.fn(),
            conflictLoadError: "Could not check the latest version.",
            disabledError: "Memory is disabled.",
            saveError: "Could not save.",
        }),
    );
}

describe("useMemoryFileController status polling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reports a failed status poll, because the poll does not re-arm itself", async () => {
        const loadMemory = vi
            .fn()
            .mockResolvedValueOnce(memory())
            .mockRejectedValue(new TypeError("Failed to fetch"));

        const { result } = renderController(loadMemory);
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            vi.advanceTimersByTime(3000);
        });

        await waitFor(() =>
            expect(vi.mocked(notifyError)).toHaveBeenCalledWith(
                expect.any(TypeError),
                expect.objectContaining({
                    action: "check for memory updates",
                    dedupeKey: "memory-file-poll",
                }),
            ),
        );
        // The file stays usable: the already-loaded content is untouched.
        expect(result.current.memory?.content).toBe("Remember this.");
        expect(result.current.loadError).toBe(false);
    });

    it("stays quiet while the status poll keeps succeeding", async () => {
        const loadMemory = vi
            .fn()
            .mockResolvedValueOnce(memory())
            .mockResolvedValue(memory({ status: "idle" }));

        const { result } = renderController(loadMemory);
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            vi.advanceTimersByTime(3000);
        });

        await waitFor(() => expect(loadMemory).toHaveBeenCalledTimes(2));
        expect(vi.mocked(notifyError)).not.toHaveBeenCalled();
    });
});

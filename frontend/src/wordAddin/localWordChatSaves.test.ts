/**
 * Device-only Word chat saves, exercised from the frontend test runner.
 *
 * Fail-without-fix: both terminal save sites in useWordAssistantChat ended in
 * `.catch(() => {})`. In `local` storage mode the on-device transcript is the
 * only copy of the turn, so a failed write silently lost the user's
 * conversation with nothing on screen and nothing to retry.
 */
import { describe, expect, it, vi } from "vitest";
import {
    LOCAL_SAVE_FAILED_MESSAGE,
    saveWordMessageOrNotify,
} from "../../../word-addin/src/taskpane/lib/localWordChatSaves";

describe("saveWordMessageOrNotify", () => {
    it("says nothing when the save succeeds", async () => {
        const notify = vi.fn();
        const save = vi.fn().mockResolvedValue(undefined);

        await saveWordMessageOrNotify({
            storage: "local",
            chatId: "chat-1",
            save,
            notify,
        });

        expect(save).toHaveBeenCalledTimes(1);
        expect(notify).not.toHaveBeenCalled();
    });

    it("stays silent in cloud mode, where the server holds the record", async () => {
        const notify = vi.fn();

        await saveWordMessageOrNotify({
            storage: "cloud",
            chatId: "chat-1",
            save: vi.fn().mockRejectedValue(new Error("QuotaExceededError")),
            notify,
        });

        expect(notify).not.toHaveBeenCalled();
    });

    it("surfaces a device-only save failure with an action and a chat-scoped dedupe key", async () => {
        const notify = vi.fn();

        await saveWordMessageOrNotify({
            storage: "local",
            chatId: "chat-1",
            save: vi.fn().mockRejectedValue(new Error("QuotaExceededError")),
            notify,
        });

        expect(notify).toHaveBeenCalledTimes(1);
        const [error, options] = notify.mock.calls[0] as [
            Error,
            Record<string, unknown>,
        ];
        expect(options.action).toBe("save this conversation on this device");
        expect(options.dedupeKey).toBe("local-word-chat-save:chat-1");
        // The storage layer's own wording never reaches the screen.
        expect(error.message).toBe(LOCAL_SAVE_FAILED_MESSAGE);
        expect(error.message).not.toContain("QuotaExceededError");
        // Declared retryable so notifyError actually renders the Retry: an
        // IndexedDB failure classifies as "unknown", which is not retryable
        // by default.
        expect(error).toMatchObject({ userVisible: true, retryable: true });
        expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
    });

    it("does not mask two different chats behind one toast", async () => {
        const notify = vi.fn();
        const fail = () => Promise.reject(new Error("nope"));

        await saveWordMessageOrNotify({
            storage: "local",
            chatId: "chat-1",
            save: fail,
            notify,
        });
        await saveWordMessageOrNotify({
            storage: "local",
            chatId: "chat-2",
            save: fail,
            notify,
        });

        const keys = notify.mock.calls.map(
            (call) => (call[1] as { dedupeKey?: string }).dedupeKey,
        );
        expect(keys).toEqual([
            "local-word-chat-save:chat-1",
            "local-word-chat-save:chat-2",
        ]);
    });

    it("re-saves the SAME message when the user retries", async () => {
        const notify = vi.fn();
        const save = vi
            .fn()
            .mockRejectedValueOnce(new Error("nope"))
            .mockResolvedValueOnce(undefined);

        await saveWordMessageOrNotify({
            storage: "local",
            chatId: "chat-1",
            save,
            notify,
        });

        const options = notify.mock.calls[0]?.[1] as {
            onRetry: () => Promise<void>;
        };
        await options.onRetry();

        expect(save).toHaveBeenCalledTimes(2);
        // The retry succeeded, so no second toast.
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it("keeps offering a retry while the save keeps failing", async () => {
        const notify = vi.fn();
        const save = vi.fn().mockRejectedValue(new Error("nope"));

        await saveWordMessageOrNotify({
            storage: "local",
            chatId: "chat-1",
            save,
            notify,
        });
        await (
            notify.mock.calls[0]?.[1] as { onRetry: () => Promise<void> }
        ).onRetry();

        expect(save).toHaveBeenCalledTimes(2);
        expect(notify).toHaveBeenCalledTimes(2);
    });
});

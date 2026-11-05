/**
 * The add-in's two pane preferences when Office provides no
 * `OfficeRuntime.storage`.
 *
 * Fail-without-fix: both hooks named the `OfficeRuntime` global inside an
 * effect. Outside Office the ReferenceError escaped the effect (no promise
 * existed for `.catch` to attach to), React logged it through console.error
 * (MIKE-WORD-ADDIN-6) and the pane fell to "Something went wrong".
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    useWordChatStoragePreference,
    useWordEditApplyMode,
} from "../../../word-addin/src/taskpane/lib/wordChatSettings";
import { paneStorage } from "../../../word-addin/src/taskpane/lib/paneStorage";

afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
});

describe("pane preferences without OfficeRuntime", () => {
    it("read and write the edit-apply mode through localStorage", async () => {
        expect("OfficeRuntime" in globalThis).toBe(false);
        localStorage.setItem("mike_word_edit_apply_mode", "direct");

        const { result } = renderHook(() => useWordEditApplyMode());
        await waitFor(() => expect(result.current.mode).toBe("direct"));

        act(() => result.current.setMode("approval"));
        await waitFor(() =>
            expect(localStorage.getItem("mike_word_edit_apply_mode")).toBe("approval"),
        );
    });

    it("read and write the chat storage choice through localStorage", async () => {
        localStorage.setItem("mike_word_chat_storage_mode:user-1", "local");

        const { result } = renderHook(() => useWordChatStoragePreference("user-1"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.mode).toBe("local");

        await act(() => result.current.setMode("cloud"));
        expect(localStorage.getItem("mike_word_chat_storage_mode:user-1")).toBe("cloud");
    });
});

describe("pane preferences inside Office", () => {
    it("use OfficeRuntime.storage, not localStorage", async () => {
        const getItem = vi.fn(async () => "direct");
        vi.stubGlobal("OfficeRuntime", {
            storage: { getItem, setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
        });
        localStorage.setItem("mike_word_edit_apply_mode", "approval");

        const { result } = renderHook(() => useWordEditApplyMode());
        await waitFor(() => expect(result.current.mode).toBe("direct"));
        expect(getItem).toHaveBeenCalledWith("mike_word_edit_apply_mode");
    });
});

// Review of #789: a browser with site data blocked throws a SecurityError
// from the `localStorage` getter itself. The fallback must turn that into a
// rejected promise, and the hooks must take their fail-closed defaults.
describe("pane preferences when localStorage is blocked", () => {
    const blockLocalStorage = () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            get() {
                throw new DOMException("The operation is insecure.", "SecurityError");
            },
        });
        return () => {
            if (original) Object.defineProperty(globalThis, "localStorage", original);
        };
    };

    it("reject instead of throwing, keep chats local, and still switch the apply mode", async () => {
        const restore = blockLocalStorage();
        try {
            expect("OfficeRuntime" in globalThis).toBe(false);
            const read = paneStorage.getItem("mike_word_edit_apply_mode");
            await expect(read).rejects.toMatchObject({ name: "SecurityError" });

            // The chat-storage read fails, so it fails closed to "local":
            // never upload the chats of a user who may have opted out.
            const chat = renderHook(() => useWordChatStoragePreference("user-1"));
            await waitFor(() => expect(chat.result.current.loading).toBe(false));
            expect(chat.result.current.mode).toBe("local");
            await expect(chat.result.current.setMode("cloud")).rejects.toMatchObject({
                name: "SecurityError",
            });

            // The Direct/Review toggle keeps working; only persistence is lost.
            const apply = renderHook(() => useWordEditApplyMode());
            expect(apply.result.current.mode).toBe("approval");
            act(() => apply.result.current.setMode("direct"));
            expect(apply.result.current.mode).toBe("direct");
        } finally {
            restore();
        }
    });
});

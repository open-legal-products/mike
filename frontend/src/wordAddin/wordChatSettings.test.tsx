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

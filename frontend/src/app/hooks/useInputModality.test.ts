import { fireEvent, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useInputModality } from "./useInputModality";

it("tracks pointer versus Tab navigation, ignoring typing", () => {
    const { unmount } = renderHook(() => useInputModality());
    const root = document.documentElement;

    fireEvent.pointerDown(document.body);
    expect(root.dataset.inputModality).toBe("pointer");
    // Typing in a field focused with the mouse keeps the pointer modality.
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(root.dataset.inputModality).toBe("pointer");

    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(root.dataset.inputModality).toBe("keyboard");

    unmount();
    expect(root.dataset.inputModality).toBeUndefined();
});

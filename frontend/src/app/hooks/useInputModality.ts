"use client";

import { useEffect } from "react";

/**
 * Record whether the user last interacted with a pointer or by tabbing, as
 * `<html data-input-modality="pointer|keyboard">`.
 *
 * Browsers always match `:focus-visible` on focused text fields, even after a
 * mouse click, so the attribute lets `.keyboard-focus-ring` (globals.css) keep
 * a field's focus ring for keyboard navigation only. Only Tab switches to
 * keyboard: typing inside a field must not bring the ring back.
 */
export function useInputModality() {
    useEffect(() => {
        const root = document.documentElement;
        const set = (modality: "pointer" | "keyboard") => {
            if (root.dataset.inputModality !== modality)
                root.dataset.inputModality = modality;
        };
        const onPointerDown = () => set("pointer");
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Tab") set("keyboard");
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
            delete root.dataset.inputModality;
        };
    }, []);
}

"use client";

import { useCallback, useRef, useState } from "react";

// Per-finding draft persistence for the contract FeedbackWidget (ported from
// Janus). The in-progress state (chosen action + typed text) lives in
// localStorage so navigating away and back restores the widget. Every storage
// access is wrapped: private mode / quota errors degrade to in-memory only.

export interface DraftFeedback {
    action: string | null;
    rationale: string;
    adjustedSeverity: string;
    editedText: string;
}

const KEY_PREFIX = "tinjau:draft:";

function defaults(initialEditedText: string): DraftFeedback {
    return { action: null, rationale: "", adjustedSeverity: "", editedText: initialEditedText };
}

function isDraftShape(v: unknown): v is DraftFeedback {
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return (
        (o.action === null || typeof o.action === "string") &&
        typeof o.rationale === "string" &&
        typeof o.adjustedSeverity === "string" &&
        typeof o.editedText === "string"
    );
}

function safeRead(key: string): DraftFeedback | null {
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!isDraftShape(parsed)) {
            safeRemove(key);
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function safeWrite(key: string, value: DraftFeedback) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* keep in-memory only */
    }
}

function safeRemove(key: string) {
    try {
        window.localStorage.removeItem(key);
    } catch {
        /* noop */
    }
}

export function useDraftFeedback(reviewId: string, findingId: string, initialEditedText = "") {
    const key = `${KEY_PREFIX}${reviewId}:${findingId}`;
    const initialEditedRef = useRef(initialEditedText);

    const [draft, setDraftState] = useState<DraftFeedback>(() => {
        if (typeof window === "undefined") return defaults(initialEditedText);
        return safeRead(key) ?? defaults(initialEditedText);
    });

    // Widgets are keyed per finding, so `key` never changes for a mounted hook;
    // the initial lazy read is the only hydration point.

    const setDraft = useCallback(
        (patch: Partial<DraftFeedback>) => {
            setDraftState((prev) => {
                const next = { ...prev, ...patch };
                safeWrite(key, next);
                return next;
            });
        },
        [key],
    );

    const clearDraft = useCallback(() => {
        safeRemove(key);
        setDraftState(defaults(initialEditedRef.current));
    }, [key]);

    return { draft, setDraft, clearDraft };
}

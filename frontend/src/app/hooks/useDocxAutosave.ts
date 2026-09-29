"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listDocumentVersions, replaceDocumentVersionFile } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { UploadBatchError } from "@/shared/api/uploadSessionClient";
import { invalidateDocxBytes } from "./useFetchDocxBytes";

export const DOCX_AUTOSAVE_DELAY = 1500;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function sha256(bytes: ArrayBuffer) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Options {
    documentId: string;
    versionId?: string | null;
    filename?: string;
    bytes: ArrayBuffer | null;
    enabled: boolean;
    exportDocx: () => Promise<ArrayBuffer> | undefined;
}

/** Serialize saves, retain edits made during upload, and stop automatic retries on failure. */
export function useDocxAutosave(options: Options) {
    const latest = useRef(options);
    useEffect(() => { latest.current = options; });
    const sequence = useRef(0);
    const savedSequence = useRef(0);
    const snapshotRevision = useRef(0);
    const savedBytes = useRef<ArrayBuffer | null>(null);
    const expectedHash = useRef<Promise<string> | null>(null);
    const targetVersion = useRef<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pending = useRef<Promise<void> | null>(null);
    const mounted = useRef(true);
    const failed = useRef(false);
    const detachedSnapshot = useRef<{ bytes: Promise<ArrayBuffer>; sequence: number } | null>(null);
    const [dirty, setDirty] = useState(false);
    const [status, setStatus] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
    const [error, setError] = useState<string | null>(null);

    const save = useCallback((): Promise<void> => {
        clearTimeout(timer.current);
        if (pending.current) return pending.current;
        if (!latest.current.enabled || sequence.current === savedSequence.current) return Promise.resolve();
        failed.current = false;
        const warnWhileSaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warnWhileSaving);
        const run = async () => {
            if (mounted.current) { setStatus("saving"); setError(null); }
            try {
                do {
                    const current = latest.current;
                    const detached = detachedSnapshot.current;
                    detachedSnapshot.current = null;
                    const savingSequence = detached?.sequence ?? sequence.current;
                    const exported = detached?.bytes ?? current.exportDocx();
                    if (!exported || !current.bytes) throw new Error("Editor is not ready");
                    // Start serialization before awaiting network work, including on unmount.
                    const bytes = await exported;
                    expectedHash.current ??= sha256(current.bytes);
                    targetVersion.current ??= current.versionId ?? null;
                    if (!targetVersion.current) {
                        targetVersion.current = (await listDocumentVersions(current.documentId)).current_version_id;
                    }
                    if (!targetVersion.current) throw new Error("Missing document version");
                    const name = current.filename || "document.docx";
                    const file = new File([bytes], /\.docx$/i.test(name) ? name : `${name}.docx`, { type: DOCX_MIME });
                    const nextHash = await sha256(bytes);
                    await replaceDocumentVersionFile(current.documentId, targetVersion.current, file, undefined, {
                        expectedContentSha256: await expectedHash.current,
                        generatePdf: false,
                    });
                    expectedHash.current = Promise.resolve(nextHash);
                    savedSequence.current = savingSequence;
                    savedBytes.current = bytes;
                    snapshotRevision.current += 1;
                    invalidateDocxBytes(current.documentId);
                    if (mounted.current && sequence.current === savingSequence) {
                        setDirty(false);
                        setStatus("saved");
                    }
                } while ((mounted.current || detachedSnapshot.current) && sequence.current > savedSequence.current);
            } catch (reason) {
                failed.current = true;
                if (mounted.current) {
                    const conflict = reason instanceof UploadBatchError
                        && reason.outcomes.some((outcome) => outcome.errorCode === "document_changed");
                    setError(conflict
                        ? "This document changed elsewhere. Download your edits before reopening the latest version."
                        : userFacingApiError(reason, "Changes could not be saved. Your edits are still open. Press Cmd/Ctrl+S to retry, or download a copy."));
                    setStatus("error");
                }
            }
        };
        pending.current = run().finally(() => {
            pending.current = null;
            window.removeEventListener("beforeunload", warnWhileSaving);
        });
        return pending.current;
    }, []);

    // Consider each server snapshot once, at arrival. A response received while
    // dirty/saving must not be replayed after a later save and revert local edits.
    const captureSnapshotRevision = useCallback(() => snapshotRevision.current, []);
    const adoptSnapshot = useCallback((bytes: ArrayBuffer, revision: number): boolean => {
        if (revision !== snapshotRevision.current || pending.current || sequence.current !== savedSequence.current) return false;
        const baseline = savedBytes.current ?? latest.current.bytes;
        if (baseline) {
            const previous = new Uint8Array(baseline);
            const next = new Uint8Array(bytes);
            // A refresh of our own save must retain the editor and its undo stack.
            if (previous.length === next.length && previous.every((byte, index) => byte === next[index])) return false;
        }
        expectedHash.current = null;
        savedBytes.current = bytes;
        snapshotRevision.current += 1;
        latest.current = { ...latest.current, bytes };
        setStatus("idle");
        return true;
    }, []);

    const markChanged = useCallback(() => {
        sequence.current += 1;
        snapshotRevision.current += 1;
        setDirty(true);
        if (!latest.current.enabled || failed.current) return;
        if (!pending.current) setStatus("pending");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { void save(); }, DOCX_AUTOSAVE_DELAY);
    }, [save]);

    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            clearTimeout(timer.current);
            // Capture pending edits before the child editor's passive teardown.
            if (!failed.current) {
                if (pending.current && sequence.current > savedSequence.current) {
                    const bytes = latest.current.exportDocx();
                    if (bytes) {
                        // Observe rejection immediately, even if the current upload fails first.
                        void bytes.catch(() => {});
                        detachedSnapshot.current = { bytes, sequence: sequence.current };
                    }
                }
                void save();
            }
        };
    }, [save]);

    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    return { dirty, status, error, markChanged, save, adoptSnapshot, captureSnapshotRevision };
}
